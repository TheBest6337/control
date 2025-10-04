use crate::{
    machines::{MACHINE_LASER_V1, VENDOR_QITECH},
    serial::devices::laser::Laser,
};
use api::{
    LaserEvents, LaserMachineNamespace, LaserState, LiveValuesEvent, MinMaxDiameterEvent,
    StateEvent,
};
use control_core::{
    machines::identification::{MachineIdentification, MachineIdentificationUnique},
    socketio::namespace::NamespaceCacheingLogic,
};
use control_core_derive::Machine;
use smol::lock::RwLock;
use std::{
    collections::VecDeque,
    sync::Arc,
    time::{Duration, Instant},
};
use uom::si::{f64::Length, length::millimeter};

pub mod act;
pub mod api;
pub mod new;

#[derive(Debug, Clone)]
pub struct DiameterMeasurement {
    pub diameter: f64,
    pub timestamp: Instant,
}

#[derive(Debug)]
pub struct DiameterTracker {
    measurements: VecDeque<DiameterMeasurement>,
    timeframe_duration: Duration,
}

impl DiameterTracker {
    pub fn new(timeframe_minutes: u64) -> Self {
        Self {
            measurements: VecDeque::new(),
            timeframe_duration: Duration::from_secs(timeframe_minutes * 60),
        }
    }

    pub fn add_measurement(&mut self, diameter: f64, timestamp: Instant) {
        // Add the new measurement
        self.measurements.push_back(DiameterMeasurement {
            diameter,
            timestamp,
        });

        // Remove old measurements outside the timeframe
        let cutoff = timestamp - self.timeframe_duration;
        while let Some(front) = self.measurements.front() {
            if front.timestamp < cutoff {
                self.measurements.pop_front();
            } else {
                break;
            }
        }
    }

    pub fn get_min_max(&self) -> (Option<f64>, Option<f64>) {
        if self.measurements.is_empty() {
            return (None, None);
        }

        let mut min = f64::INFINITY;
        let mut max = f64::NEG_INFINITY;

        for measurement in &self.measurements {
            if measurement.diameter < min {
                min = measurement.diameter;
            }
            if measurement.diameter > max {
                max = measurement.diameter;
            }
        }

        (Some(min), Some(max))
    }

    pub fn set_timeframe(&mut self, timeframe_minutes: u64) {
        self.timeframe_duration = Duration::from_secs(timeframe_minutes * 60);

        // Clean up measurements that are now outside the new timeframe
        if let Some(latest) = self.measurements.back() {
            let cutoff = latest.timestamp - self.timeframe_duration;
            while let Some(front) = self.measurements.front() {
                if front.timestamp < cutoff {
                    self.measurements.pop_front();
                } else {
                    break;
                }
            }
        }
    }
}

#[derive(Debug, Machine)]
pub struct LaserMachine {
    machine_identification_unique: MachineIdentificationUnique,

    // drivers
    laser: Arc<RwLock<Laser>>,

    // socketio
    namespace: LaserMachineNamespace,
    last_measurement_emit: Instant,
    last_minmax_emit: Instant,

    // laser values
    diameter: Length,
    x_diameter: Option<Length>,
    y_diameter: Option<Length>,
    roundness: Option<f64>,

    // diameter tracking for min/max over timeframe
    diameter_tracker: DiameterTracker,

    //laser target configuration
    laser_target: LaserTarget,

    /// Will be initialized as false and set to true by emit_state
    /// This way we can signal to the client that the first state emission is a default state
    emitted_default_state: bool,
}

impl LaserMachine {
    pub const MACHINE_IDENTIFICATION: MachineIdentification = MachineIdentification {
        vendor: VENDOR_QITECH,
        machine: MACHINE_LASER_V1,
    };

    ///diameter in mm
    pub fn emit_live_values(&mut self) {
        let diameter = self.diameter.get::<millimeter>();
        let x_diameter = self.x_diameter.map(|x| x.get::<millimeter>());
        let y_diameter = self.y_diameter.map(|y| y.get::<millimeter>());
        let roundness = self.roundness;

        let live_values = LiveValuesEvent {
            diameter,
            x_diameter,
            y_diameter,
            roundness,
        };
        self.namespace
            .emit(LaserEvents::LiveValues(live_values.build()));
    }

    pub fn emit_min_max_diameter(&mut self) {
        let (min_diameter, max_diameter) = self.get_min_max_diameter();
        let min_max_event = MinMaxDiameterEvent {
            min_diameter,
            max_diameter,
            timeframe_minutes: self.laser_target.min_max_timeframe_minutes,
        };
        self.namespace
            .emit(LaserEvents::MinMaxDiameter(min_max_event.build()));
    }

    pub fn build_state_event(&self) -> StateEvent {
        let laser = LaserState {
            higher_tolerance: self.laser_target.higher_tolerance.get::<millimeter>(),
            lower_tolerance: self.laser_target.lower_tolerance.get::<millimeter>(),
            target_diameter: self.laser_target.diameter.get::<millimeter>(),
            min_max_timeframe_minutes: self.laser_target.min_max_timeframe_minutes,
        };

        StateEvent {
            is_default_state: false,
            laser_state: laser,
        }
    }

    pub fn emit_state(&mut self) {
        let state = StateEvent {
            is_default_state: !std::mem::replace(&mut self.emitted_default_state, true),
            laser_state: LaserState {
                higher_tolerance: self.laser_target.higher_tolerance.get::<millimeter>(),
                lower_tolerance: self.laser_target.lower_tolerance.get::<millimeter>(),
                target_diameter: self.laser_target.diameter.get::<millimeter>(),
                min_max_timeframe_minutes: self.laser_target.min_max_timeframe_minutes,
            },
        };

        self.namespace.emit(LaserEvents::State(state.build()));
    }

    pub fn set_higher_tolerance(&mut self, higher_tolerance: f64) {
        self.laser_target.higher_tolerance = Length::new::<millimeter>(higher_tolerance);
        self.emit_state();
    }

    pub fn set_lower_tolerance(&mut self, lower_tolerance: f64) {
        self.laser_target.lower_tolerance = Length::new::<millimeter>(lower_tolerance);
        self.emit_state();
    }

    pub fn set_target_diameter(&mut self, target_diameter: f64) {
        self.laser_target.diameter = Length::new::<millimeter>(target_diameter);
        self.emit_state();
    }

    pub fn set_min_max_timeframe(&mut self, timeframe_minutes: u64) {
        self.laser_target.min_max_timeframe_minutes = timeframe_minutes;
        self.diameter_tracker.set_timeframe(timeframe_minutes);
        self.emit_state();
    }

    pub fn get_min_max_diameter(&self) -> (Option<f64>, Option<f64>) {
        self.diameter_tracker.get_min_max()
    }

    ///
    /// Roundness = min(x, y) / max(x, y)
    ///
    fn calculate_roundness(&mut self) -> Option<f64> {
        match (self.x_diameter, self.y_diameter) {
            (Some(x), Some(y)) => {
                let x_val = x.get::<millimeter>();
                let y_val = y.get::<millimeter>();

                if x_val > 0.0 && y_val > 0.0 {
                    let roundness = f64::min(x_val, y_val) / f64::max(x_val, y_val);
                    Some(roundness)
                } else if x_val == 0.0 && y_val == 0.0 {
                    Some(0.0)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    pub fn update(&mut self) {
        let laser_data = smol::block_on(async { self.laser.read().await.get_data().await });
        let diameter_mm = laser_data
            .as_ref()
            .map(|data| data.diameter.get::<millimeter>())
            .unwrap_or(0.0);

        self.diameter = Length::new::<millimeter>(diameter_mm);

        // Add diameter measurement to tracker if we have valid data
        if diameter_mm > 0.0 {
            self.diameter_tracker
                .add_measurement(diameter_mm, Instant::now());
        }

        self.x_diameter = laser_data
            .as_ref()
            .and_then(|data| data.x_axis.as_ref())
            .cloned();

        self.y_diameter = laser_data
            .as_ref()
            .and_then(|data| data.y_axis.as_ref())
            .cloned();

        self.roundness = self.calculate_roundness();
    }
}

#[derive(Debug, Clone)]
pub struct LaserTarget {
    diameter: Length,
    lower_tolerance: Length,
    higher_tolerance: Length,
    min_max_timeframe_minutes: u64, // timeframe in minutes for min/max tracking
}
