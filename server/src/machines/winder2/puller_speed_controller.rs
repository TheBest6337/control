use std::time::Instant;

use control_core::{
    controllers::second_degree_motion::linear_jerk_speed_controller::LinearJerkSpeedController,
    converters::linear_step_converter::LinearStepConverter,
    uom_extensions::{
        acceleration::meter_per_minute_per_second, jerk::meter_per_minute_per_second_squared,
        velocity::meter_per_minute,
    },
};
use serde::{Deserialize, Serialize};
use uom::{
    ConstZero,
    si::f64::{Acceleration, AngularVelocity, Jerk, Length, Velocity},
};

#[derive(Debug)]
pub struct PullerSpeedController {
    enabled: bool,
    pub target_speed: Velocity,
    pub target_diameter: Length,
    pub regulation_mode: PullerRegulationMode,
    /// Forward rotation direction. If false, applies negative sign to speed
    pub forward: bool,
    /// Linear acceleration controller to dampen speed change
    acceleration_controller: LinearJerkSpeedController,
    /// Converter for linear to angular transformations
    pub converter: LinearStepConverter,
    pub last_speed: Velocity,
}

impl PullerSpeedController {
    pub fn new(
        target_speed: Velocity,
        target_diameter: Length,
        converter: LinearStepConverter,
    ) -> Self {
        let acceleration = Acceleration::new::<meter_per_minute_per_second>(5.0);
        let jerk = Jerk::new::<meter_per_minute_per_second_squared>(10.0);
        let speed = Velocity::new::<meter_per_minute>(50.0);

        Self {
            enabled: false,
            target_speed,
            target_diameter,
            regulation_mode: PullerRegulationMode::Speed,
            forward: true,
            acceleration_controller: LinearJerkSpeedController::new_simple(
                Some(speed),
                acceleration,
                jerk,
            ),
            converter,
            last_speed: Velocity::ZERO,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn set_target_speed(&mut self, target: Velocity) {
        self.target_speed = target;
    }

    pub fn set_target_diameter(&mut self, target: Length) {
        self.target_diameter = target;
    }

    pub fn set_regulation_mode(&mut self, regulation: PullerRegulationMode) {
        self.regulation_mode = regulation;
    }

    pub fn set_forward(&mut self, forward: bool) {
        self.forward = forward;
    }

    /// Get current regulation mode
    pub fn get_regulation_mode(&self) -> &PullerRegulationMode {
        &self.regulation_mode
    }

    fn update_speed(&mut self, t: Instant) -> Velocity {
        let speed = match self.enabled {
            true => match self.regulation_mode {
                PullerRegulationMode::Speed => self.target_speed,
                PullerRegulationMode::Diameter => {
                    // In diameter mode, calculate speed based on target diameter and volume flow
                    // This is a simplified implementation - in practice, you'd integrate with
                    // the DiameterController for more sophisticated control
                    self.calculate_speed_for_diameter()
                },
            },
            false => Velocity::ZERO,
        };

        let speed = if self.forward { speed } else { -speed };

        let speed = self.acceleration_controller.update(speed, t);

        self.last_speed = speed;
        speed
    }

    /// Calculate the required puller speed to achieve target diameter
    /// This is a simplified calculation - in practice, this would be integrated
    /// with the DiameterController and real-time diameter feedback
    fn calculate_speed_for_diameter(&self) -> Velocity {
        // Basic calculation based on target diameter
        // For a given volume flow rate, the required speed is:
        // speed = volume_flow_rate / cross_sectional_area
        // cross_sectional_area = π × (diameter/2)²
        
        let diameter_m = self.target_diameter.get::<uom::si::length::meter>();
        let radius_m = diameter_m / 2.0;
        let cross_section_area = std::f64::consts::PI * radius_m * radius_m;
        
        // Assume a nominal volume flow rate - this should come from extruder feedback
        let nominal_volume_flow = 0.5e-6; // m³/s (0.5 cm³/s converted to m³/s)
        
        let required_speed = nominal_volume_flow / cross_section_area;
        
        Velocity::new::<uom::si::velocity::meter_per_second>(required_speed)
    }

    pub fn speed_to_angular_velocity(&self, speed: Velocity) -> AngularVelocity {
        // Use the converter to transform from linear velocity to angular velocity
        self.converter.velocity_to_angular_velocity(speed)
    }

    pub fn angular_velocity_to_speed(&self, angular_speed: AngularVelocity) -> Velocity {
        // Use the converter to transform from angular velocity to linear velocity
        self.converter.angular_velocity_to_velocity(angular_speed)
    }

    pub fn calc_angular_velocity(&mut self, t: Instant) -> AngularVelocity {
        let speed = self.update_speed(t);
        self.speed_to_angular_velocity(speed)
    }

    pub fn get_target_speed(&self) -> Velocity {
        self.target_speed
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum PullerRegulationMode {
    Speed,
    Diameter,
}
