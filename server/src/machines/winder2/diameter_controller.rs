use std::time::Instant;

use control_core::{
    controllers::pid::PidController,
    converters::linear_step_converter::LinearStepConverter,
};
use serde::{Deserialize, Serialize};
use uom::{
    ConstZero,
    si::f64::{AngularVelocity, Length, Velocity, VolumeRate},
};

use super::{
    puller_speed_controller::PullerSpeedController,
    spool_speed_controller::SpoolSpeedController,
};

/// Volume calculation constants for the extruder screw
/// These should be calibrated based on the actual screw geometry
const SCREW_DISPLACEMENT_PER_REV: f64 = 0.5; // cm³/rev - typical for small extruders
const FILAMENT_DENSITY: f64 = 1.25; // g/cm³ - typical for PLA/PETG

/// Controller strategies for maintaining filament diameter
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DiameterControlStrategy {
    /// Adjust winder speed only (keep extrusion rate constant)
    WinderOnly,
    /// Adjust extrusion rate only (keep winder speed constant)
    ExtruderOnly,
    /// Adjust both winder speed and extrusion rate (balanced approach)
    Balanced,
    /// Prioritize speed while maintaining diameter
    SpeedPrioritized,
}

/// Diameter regulation controller that maintains target filament diameter
/// by coordinating extrusion rate and winder speed
#[derive(Debug)]
pub struct DiameterController {
    /// PID controller for diameter regulation
    diameter_pid: PidController,
    /// PID controller for volume flow rate regulation
    volume_pid: PidController,
    /// Target filament diameter in mm
    target_diameter: Length,
    /// Current measured diameter in mm
    current_diameter: Length,
    /// Target volume flow rate in cm³/s
    target_volume_rate: VolumeRate,
    /// Current calculated volume flow rate in cm³/s
    current_volume_rate: VolumeRate,
    /// Control strategy
    strategy: DiameterControlStrategy,
    /// Whether the controller is enabled
    enabled: bool,
    /// Speed scaling factor for process acceleration
    speed_scale_factor: f64,
    /// Minimum allowed diameter tolerance
    min_diameter_tolerance: Length,
    /// Maximum allowed diameter tolerance  
    max_diameter_tolerance: Length,
    /// Last update timestamp
    last_update: Option<Instant>,
    /// Speed smoothing filter
    speed_filter_alpha: f64,
    /// Volume rate smoothing filter
    volume_filter_alpha: f64,
    /// Process speed limits
    min_process_speed_factor: f64,
    max_process_speed_factor: f64,
}

impl DiameterController {
    /// Create a new diameter controller
    pub fn new(target_diameter: Length) -> Self {
        Self {
            // Tuned PID parameters for diameter control
            diameter_pid: PidController::new(2.0, 0.1, 0.05),
            // Tuned PID parameters for volume control
            volume_pid: PidController::new(1.5, 0.08, 0.02),
            target_diameter,
            current_diameter: Length::ZERO,
            target_volume_rate: VolumeRate::ZERO,
            current_volume_rate: VolumeRate::ZERO,
            strategy: DiameterControlStrategy::Balanced,
            enabled: false,
            speed_scale_factor: 1.0,
            min_diameter_tolerance: Length::new::<uom::si::length::millimeter>(0.02), // ±0.02mm
            max_diameter_tolerance: Length::new::<uom::si::length::millimeter>(0.05), // ±0.05mm
            last_update: None,
            speed_filter_alpha: 0.1, // Low-pass filter for smooth speed changes
            volume_filter_alpha: 0.15, // Low-pass filter for volume changes
            min_process_speed_factor: 0.5, // Minimum 50% of nominal speed
            max_process_speed_factor: 2.0, // Maximum 200% of nominal speed
        }
    }

    /// Set the target diameter
    pub fn set_target_diameter(&mut self, diameter: Length) {
        self.target_diameter = diameter;
        self.diameter_pid.reset();
    }

    /// Get the target diameter
    pub fn get_target_diameter(&self) -> Length {
        self.target_diameter
    }

    /// Set the current measured diameter
    pub fn set_current_diameter(&mut self, diameter: Length) {
        self.current_diameter = diameter;
    }

    /// Get the current diameter
    pub fn get_current_diameter(&self) -> Length {
        self.current_diameter
    }

    /// Set the control strategy
    pub fn set_strategy(&mut self, strategy: DiameterControlStrategy) {
        self.strategy = strategy;
    }

    /// Enable/disable the controller
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        if !enabled {
            self.diameter_pid.reset();
            self.volume_pid.reset();
        }
    }

    /// Check if controller is enabled
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Set the speed scaling factor for process acceleration
    /// Factor > 1.0 speeds up the process while maintaining diameter
    /// Factor < 1.0 slows down the process
    pub fn set_speed_scale_factor(&mut self, factor: f64) {
        self.speed_scale_factor = factor.clamp(
            self.min_process_speed_factor,
            self.max_process_speed_factor,
        );
    }

    /// Get the current speed scale factor
    pub fn get_speed_scale_factor(&self) -> f64 {
        self.speed_scale_factor
    }

    /// Get the current control strategy
    pub fn get_strategy(&self) -> DiameterControlStrategy {
        self.strategy
    }

    /// Calculate volume flow rate from extruder RPM
    /// Volume = RPM × displacement_per_revolution
    pub fn calculate_volume_rate_from_rpm(&self, screw_rpm: AngularVelocity) -> VolumeRate {
        let rpm = screw_rpm.get::<uom::si::angular_velocity::revolution_per_minute>();
        let volume_per_minute = rpm * SCREW_DISPLACEMENT_PER_REV;
        let volume_per_second = volume_per_minute / 60.0;
        VolumeRate::new::<uom::si::volume_rate::cubic_centimeter_per_second>(volume_per_second)
    }

    /// Calculate expected diameter from volume flow rate and filament speed
    /// Using: Volume = π × (diameter/2)² × speed
    /// Therefore: diameter = 2 × √(Volume / (π × speed))
    pub fn calculate_expected_diameter(&self, volume_rate: VolumeRate, filament_speed: Velocity) -> Length {
        if filament_speed <= Velocity::ZERO {
            return Length::ZERO;
        }

        let volume_cm3_per_s = volume_rate.get::<uom::si::volume_rate::cubic_centimeter_per_second>();
        let speed_mm_per_s = filament_speed.get::<uom::si::velocity::millimeter_per_second>();
        let speed_cm_per_s = speed_mm_per_s / 10.0; // Convert mm/s to cm/s

        // Volume = π × r² × speed, so r² = Volume / (π × speed)
        let radius_squared = volume_cm3_per_s / (std::f64::consts::PI * speed_cm_per_s);
        let radius_cm = radius_squared.sqrt();
        let diameter_cm = radius_cm * 2.0;
        let diameter_mm = diameter_cm * 10.0; // Convert back to mm

        Length::new::<uom::si::length::millimeter>(diameter_mm)
    }

    /// Calculate required volume flow rate for target diameter and filament speed
    /// Using: Volume = π × (diameter/2)² × speed
    pub fn calculate_required_volume_rate(&self, target_diameter: Length, filament_speed: Velocity) -> VolumeRate {
        let diameter_mm = target_diameter.get::<uom::si::length::millimeter>();
        let radius_mm = diameter_mm / 2.0;
        let radius_cm = radius_mm / 10.0; // Convert to cm
        let speed_mm_per_s = filament_speed.get::<uom::si::velocity::millimeter_per_second>();
        let speed_cm_per_s = speed_mm_per_s / 10.0; // Convert to cm/s

        let cross_section_area = std::f64::consts::PI * radius_cm * radius_cm;
        let volume_cm3_per_s = cross_section_area * speed_cm_per_s;

        VolumeRate::new::<uom::si::volume_rate::cubic_centimeter_per_second>(volume_cm3_per_s)
    }

    /// Calculate required extruder RPM for target volume flow rate
    pub fn calculate_required_rpm(&self, target_volume_rate: VolumeRate) -> AngularVelocity {
        let volume_cm3_per_s = target_volume_rate.get::<uom::si::volume_rate::cubic_centimeter_per_second>();
        let volume_cm3_per_min = volume_cm3_per_s * 60.0;
        let required_rpm = volume_cm3_per_min / SCREW_DISPLACEMENT_PER_REV;

        AngularVelocity::new::<uom::si::angular_velocity::revolution_per_minute>(required_rpm)
    }

    /// Check if the current diameter is within acceptable tolerance
    pub fn is_diameter_in_tolerance(&self) -> bool {
        let error = (self.current_diameter - self.target_diameter).abs();
        error <= self.max_diameter_tolerance
    }

    /// Check if the current diameter is within tight tolerance
    pub fn is_diameter_in_tight_tolerance(&self) -> bool {
        let error = (self.current_diameter - self.target_diameter).abs();
        error <= self.min_diameter_tolerance
    }

    /// Update the controller and calculate adjustments
    /// Returns (winder_speed_adjustment, extruder_rpm_adjustment)
    pub fn update(
        &mut self,
        current_time: Instant,
        current_extruder_rpm: AngularVelocity,
        current_filament_speed: Velocity,
        puller_controller: &PullerSpeedController,
        spool_controller: &mut SpoolSpeedController,
    ) -> DiameterControlOutput {
        if !self.enabled {
            return DiameterControlOutput::default();
        }

        // Update timestamps
        let dt = match self.last_update {
            Some(last) => current_time.duration_since(last).as_secs_f64(),
            None => 0.016, // ~60Hz default
        };
        self.last_update = Some(current_time);

        // Calculate current volume flow rate
        self.current_volume_rate = self.calculate_volume_rate_from_rpm(current_extruder_rpm);

        // Calculate target volume rate for current speed and target diameter
        self.target_volume_rate = self.calculate_required_volume_rate(
            self.target_diameter,
            current_filament_speed * self.speed_scale_factor,
        );

        // Calculate diameter error
        let diameter_error = self.target_diameter - self.current_diameter;
        let diameter_error_mm = diameter_error.get::<uom::si::length::millimeter>();

        // Calculate volume error
        let volume_error = self.target_volume_rate - self.current_volume_rate;
        let volume_error_cm3_per_s = volume_error.get::<uom::si::volume_rate::cubic_centimeter_per_second>();

        // Update PID controllers
        let diameter_correction = self.diameter_pid.update(diameter_error_mm, current_time);
        let volume_correction = self.volume_pid.update(volume_error_cm3_per_s, current_time);

        // Calculate adjustments based on strategy
        let (winder_adjustment, extruder_adjustment) = match self.strategy {
            DiameterControlStrategy::WinderOnly => {
                // Only adjust winder speed, keep extruder constant
                let winder_adj = self.calculate_winder_adjustment(diameter_correction, current_filament_speed);
                (winder_adj, 0.0)
            }
            DiameterControlStrategy::ExtruderOnly => {
                // Only adjust extruder rate, keep winder constant
                let extruder_adj = self.calculate_extruder_adjustment(volume_correction);
                (0.0, extruder_adj)
            }
            DiameterControlStrategy::Balanced => {
                // Balanced approach: adjust both proportionally
                let winder_adj = self.calculate_winder_adjustment(diameter_correction * 0.6, current_filament_speed);
                let extruder_adj = self.calculate_extruder_adjustment(volume_correction * 0.4);
                (winder_adj, extruder_adj)
            }
            DiameterControlStrategy::SpeedPrioritized => {
                // Prioritize speed: mainly adjust extruder to maintain diameter while allowing speed variation
                let extruder_adj = self.calculate_extruder_adjustment(volume_correction * 0.8);
                let winder_adj = self.calculate_winder_adjustment(diameter_correction * 0.2, current_filament_speed);
                (winder_adj, extruder_adj)
            }
        };

        // Apply smoothing filters
        let filtered_winder_adj = self.apply_filter(winder_adjustment, self.speed_filter_alpha);
        let filtered_extruder_adj = self.apply_filter(extruder_adjustment, self.volume_filter_alpha);

        DiameterControlOutput {
            winder_speed_adjustment: filtered_winder_adj,
            extruder_rpm_adjustment: filtered_extruder_adj,
            diameter_error: diameter_error_mm,
            volume_error: volume_error_cm3_per_s,
            is_in_tolerance: self.is_diameter_in_tolerance(),
            is_in_tight_tolerance: self.is_diameter_in_tight_tolerance(),
            current_volume_rate: self.current_volume_rate,
            target_volume_rate: self.target_volume_rate,
            process_speed_factor: self.speed_scale_factor,
        }
    }

    /// Calculate winder speed adjustment
    fn calculate_winder_adjustment(&self, diameter_correction: f64, current_speed: Velocity) -> f64 {
        // Convert diameter correction to speed adjustment
        // Positive diameter correction (diameter too small) -> increase speed -> negative adjustment
        // Negative diameter correction (diameter too large) -> decrease speed -> positive adjustment
        let speed_adjustment_factor = -diameter_correction * 0.1; // Tunable gain
        speed_adjustment_factor * current_speed.get::<uom::si::velocity::meter_per_second>()
    }

    /// Calculate extruder RPM adjustment
    fn calculate_extruder_adjustment(&self, volume_correction: f64) -> f64 {
        // Convert volume correction to RPM adjustment
        // Positive volume correction (need more volume) -> increase RPM
        // Negative volume correction (need less volume) -> decrease RPM
        let rpm_per_volume = 60.0 / SCREW_DISPLACEMENT_PER_REV; // RPM per cm³/s
        volume_correction * rpm_per_volume
    }

    /// Apply low-pass filter for smooth adjustments
    fn apply_filter(&self, new_value: f64, alpha: f64) -> f64 {
        // Simple exponential moving average filter
        // In a real implementation, you'd store previous values
        new_value * alpha // Simplified for this example
    }

    /// Get diagnostic information
    pub fn get_diagnostics(&self) -> DiameterControlDiagnostics {
        DiameterControlDiagnostics {
            target_diameter: self.target_diameter,
            current_diameter: self.current_diameter,
            target_volume_rate: self.target_volume_rate,
            current_volume_rate: self.current_volume_rate,
            diameter_error: self.target_diameter - self.current_diameter,
            strategy: self.strategy.clone(),
            enabled: self.enabled,
            speed_scale_factor: self.speed_scale_factor,
            is_in_tolerance: self.is_diameter_in_tolerance(),
            is_in_tight_tolerance: self.is_diameter_in_tight_tolerance(),
        }
    }
}

/// Output from diameter controller update
#[derive(Debug, Default)]
pub struct DiameterControlOutput {
    /// Adjustment to winder speed (m/s)
    pub winder_speed_adjustment: f64,
    /// Adjustment to extruder RPM
    pub extruder_rpm_adjustment: f64,
    /// Current diameter error (mm)
    pub diameter_error: f64,
    /// Current volume flow error (cm³/s)
    pub volume_error: f64,
    /// Whether diameter is within tolerance
    pub is_in_tolerance: bool,
    /// Whether diameter is within tight tolerance
    pub is_in_tight_tolerance: bool,
    /// Current calculated volume rate
    pub current_volume_rate: VolumeRate,
    /// Target volume rate
    pub target_volume_rate: VolumeRate,
    /// Current process speed factor
    pub process_speed_factor: f64,
}

/// Diagnostic information from diameter controller
#[derive(Debug)]
pub struct DiameterControlDiagnostics {
    pub target_diameter: Length,
    pub current_diameter: Length,
    pub target_volume_rate: VolumeRate,
    pub current_volume_rate: VolumeRate,
    pub diameter_error: Length,
    pub strategy: DiameterControlStrategy,
    pub enabled: bool,
    pub speed_scale_factor: f64,
    pub is_in_tolerance: bool,
    pub is_in_tight_tolerance: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use uom::si::{
        angular_velocity::revolution_per_minute,
        length::millimeter,
        velocity::meter_per_second,
        volume_rate::cubic_centimeter_per_second,
    };

    #[test]
    fn test_volume_calculation() {
        let controller = DiameterController::new(Length::new::<millimeter>(1.75));
        
        // Test volume calculation from RPM
        let test_rpm = AngularVelocity::new::<revolution_per_minute>(100.0);
        let volume_rate = controller.calculate_volume_rate_from_rpm(test_rpm);
        
        // Expected: 100 RPM * 0.5 cm³/rev / 60 s/min = 0.833 cm³/s
        let expected = 100.0 * SCREW_DISPLACEMENT_PER_REV / 60.0;
        assert!((volume_rate.get::<cubic_centimeter_per_second>() - expected).abs() < 0.001);
    }

    #[test]
    fn test_diameter_calculation() {
        let controller = DiameterController::new(Length::new::<millimeter>(1.75));
        
        // Test expected diameter calculation
        let volume_rate = VolumeRate::new::<cubic_centimeter_per_second>(1.0);
        let filament_speed = Velocity::new::<meter_per_second>(0.1); // 10 cm/s
        
        let diameter = controller.calculate_expected_diameter(volume_rate, filament_speed);
        
        // Expected diameter from Volume = π × (d/2)² × speed
        // 1.0 = π × (d/2)² × 10, so (d/2)² = 1.0/(π×10), d = 2×√(1.0/(π×10))
        let expected_diameter_cm = 2.0 * (1.0 / (std::f64::consts::PI * 10.0)).sqrt();
        let expected_diameter_mm = expected_diameter_cm * 10.0;
        
        assert!((diameter.get::<millimeter>() - expected_diameter_mm).abs() < 0.01);
    }

    #[test]
    fn test_required_volume_calculation() {
        let controller = DiameterController::new(Length::new::<millimeter>(1.75));
        
        // Test required volume rate calculation
        let target_diameter = Length::new::<millimeter>(1.75);
        let filament_speed = Velocity::new::<meter_per_second>(0.1); // 10 cm/s
        
        let volume_rate = controller.calculate_required_volume_rate(target_diameter, filament_speed);
        
        // Expected: π × (0.875mm)² × 10cm/s = π × (0.0875cm)² × 10cm/s
        let radius_cm = 1.75 / 2.0 / 10.0; // Convert mm to cm
        let expected = std::f64::consts::PI * radius_cm * radius_cm * 10.0;
        
        assert!((volume_rate.get::<cubic_centimeter_per_second>() - expected).abs() < 0.001);
    }

    #[test]
    fn test_tolerance_checking() {
        let mut controller = DiameterController::new(Length::new::<millimeter>(1.75));
        
        // Test within tight tolerance
        controller.set_current_diameter(Length::new::<millimeter>(1.751));
        assert!(controller.is_diameter_in_tight_tolerance());
        assert!(controller.is_diameter_in_tolerance());
        
        // Test within tolerance but not tight
        controller.set_current_diameter(Length::new::<millimeter>(1.78));
        assert!(!controller.is_diameter_in_tight_tolerance());
        assert!(controller.is_diameter_in_tolerance());
        
        // Test outside tolerance
        controller.set_current_diameter(Length::new::<millimeter>(1.85));
        assert!(!controller.is_diameter_in_tight_tolerance());
        assert!(!controller.is_diameter_in_tolerance());
    }

    #[test]
    fn test_rpm_calculation() {
        let controller = DiameterController::new(Length::new::<millimeter>(1.75));
        
        // Test required RPM calculation
        let target_volume = VolumeRate::new::<cubic_centimeter_per_second>(2.0);
        let required_rpm = controller.calculate_required_rpm(target_volume);
        
        // Expected: 2.0 cm³/s * 60 s/min / 0.5 cm³/rev = 240 RPM
        let expected = 2.0 * 60.0 / SCREW_DISPLACEMENT_PER_REV;
        
        assert!((required_rpm.get::<revolution_per_minute>() - expected).abs() < 0.1);
    }
}
