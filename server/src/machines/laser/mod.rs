use crate::{
    machines::{MACHINE_LASER_V1, VENDOR_QITECH},
    serial::devices::laser::Laser,
};
use api::{LaserEvents, LaserMachineNamespace, LaserState, LiveValuesEvent, StateEvent};
use control_core::{
    helpers::hasher_serializer::check_hash_different,
    machines::{Machine, identification::MachineIdentification},
    socketio::namespace::NamespaceCacheingLogic,
};
use smol::lock::RwLock;
use std::{any::Any, sync::Arc, time::Instant};
use uom::si::{f64::Length, length::millimeter};

pub mod act;
pub mod api;
pub mod new;

#[derive(Debug)]
pub struct LaserMachine {
    // drivers
    laser: Arc<RwLock<Laser>>,

    // socketio
    namespace: LaserMachineNamespace,
    last_measurement_emit: Instant,

    //laser target configuration
    laser_target: LaserTarget,

    /// Will be initialized as false and set to true by emit_state
    /// This way we can signal to the client that the first state emission is a default state
    emitted_default_state: bool,
    last_state_event: Option<StateEvent>,
}

impl Machine for LaserMachine {
    fn as_any(&self) -> &dyn Any {
        self
    }
}

impl LaserMachine {
    pub const MACHINE_IDENTIFICATION: MachineIdentification = MachineIdentification {
        vendor: VENDOR_QITECH,
        machine: MACHINE_LASER_V1,
    };
}

impl LaserMachine {
    ///diameter in mm
    pub fn emit_live_values(&mut self) {
        let diameter = smol::block_on(async {
            self.laser
                .read()
                .await
                .get_data()
                .await
                .map(|laser_data| laser_data.diameter.get::<millimeter>())
        });
        let live_values = LiveValuesEvent {
            diameter: diameter.unwrap_or(0.0),
        };
        self.namespace
            .emit(LaserEvents::LiveValues(live_values.build()));
    }

    pub fn build_state_event(&self) -> StateEvent {
        let laser = LaserState {
            higher_tolerance: self.laser_target.higher_tolerance.get::<millimeter>(),
            lower_tolerance: self.laser_target.lower_tolerance.get::<millimeter>(),
            target_diameter: self.laser_target.diameter.get::<millimeter>(),
        };

        StateEvent {
            is_default_state: false,
            laser_state: laser,
        }
    }

    pub fn maybe_emit_state_event(&mut self) {
        let new_state: StateEvent = self.build_state_event();
        let old_state: &StateEvent = match &self.last_state_event {
            Some(old_state) => old_state,
            None => {
                self.emit_state();
                return;
            }
        };

        let should_emit = check_hash_different(&new_state, old_state);
        if should_emit {
            let event = &new_state.build();
            self.last_state_event = Some(new_state);
            self.namespace.emit(LaserEvents::State(event.clone()));
        }
    }

    pub fn emit_state(&mut self) {
        let state = StateEvent {
            is_default_state: !std::mem::replace(&mut self.emitted_default_state, true),
            laser_state: LaserState {
                higher_tolerance: self.laser_target.higher_tolerance.get::<millimeter>(),
                lower_tolerance: self.laser_target.lower_tolerance.get::<millimeter>(),
                target_diameter: self.laser_target.diameter.get::<millimeter>(),
            },
        };

        self.namespace.emit(LaserEvents::State(state.build()));
    }

    pub fn set_higher_tolerance(&mut self, higher_tolerance: f64) {
        self.laser_target.higher_tolerance = Length::new::<millimeter>(higher_tolerance);
    }

    pub fn set_lower_tolerance(&mut self, lower_tolerance: f64) {
        self.laser_target.lower_tolerance = Length::new::<millimeter>(lower_tolerance);
    }

    pub fn set_target_diameter(&mut self, target_diameter: f64) {
        self.laser_target.diameter = Length::new::<millimeter>(target_diameter);
    }
}
#[derive(Debug, Clone)]
pub struct LaserTarget {
    diameter: Length,
    lower_tolerance: Length,
    higher_tolerance: Length,
}
