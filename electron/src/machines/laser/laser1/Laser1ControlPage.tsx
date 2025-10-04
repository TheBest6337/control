import { ControlCard } from "@/control/ControlCard";
import { Page } from "@/components/Page";
import React from "react";
import { ControlGrid } from "@/control/ControlGrid";
import { TimeSeriesValueNumeric } from "@/control/TimeSeriesValue";
import { Icon } from "@/components/Icon";

import { EditValue } from "@/control/EditValue";
import { Label } from "@/control/Label";

import { useLaser1 } from "./useLaser1";

import { DiameterVisualisation } from "../DiameterVisualisation";

export function Laser1ControlPage() {
  const {
    diameter,
    x_diameter,
    y_diameter,
    roundness,
    state,
    defaultState,
    minMaxDiameter,
    setTargetDiameter,
    setLowerTolerance,
    setHigherTolerance,
    setMinMaxTimeframe,
  } = useLaser1();

  // Extract values from consolidated state
  const targetDiameter = state?.laser_state?.target_diameter ?? 0;
  const lowerTolerance = state?.laser_state?.lower_tolerance ?? 0;
  const higherTolerance = state?.laser_state?.higher_tolerance ?? 0;
  const minMaxTimeframeMinutes =
    state?.laser_state?.min_max_timeframe_minutes ?? 30;
  return (
    <Page>
      <ControlGrid columns={2}>
        <ControlCard title="Diameter Measurement">
          <DiameterVisualisation
            targetDiameter={targetDiameter}
            lowTolerance={lowerTolerance}
            highTolerance={higherTolerance}
            diameter={diameter}
            x_diameter={x_diameter}
            y_diameter={y_diameter}
          />
          <div className="flex flex-row items-center gap-6">
            <TimeSeriesValueNumeric
              label="Diameter"
              unit="mm"
              timeseries={diameter}
              renderValue={(value) => value.toFixed(3)}
            />
          </div>
          {x_diameter?.current && (
            <div className="flex flex-row items-center gap-6">
              <TimeSeriesValueNumeric
                label="X-Diameter"
                unit="mm"
                timeseries={x_diameter}
                renderValue={(value) => value.toFixed(3)}
              />
            </div>
          )}
          {y_diameter?.current && (
            <div className="flex flex-row items-center gap-6">
              <TimeSeriesValueNumeric
                label="Y-Diameter"
                unit="mm"
                timeseries={y_diameter}
                renderValue={(value) => value.toFixed(3)}
              />
            </div>
          )}
          {roundness?.current && (
            <div className="flex flex-row items-center gap-6">
              <TimeSeriesValueNumeric
                label="Roundness"
                timeseries={roundness}
                renderValue={(value) => value.toFixed(3)}
              />
            </div>
          )}

          {/* Min/Max Diameter Information */}
          {minMaxDiameter?.data && (
            <>
              {minMaxDiameter.data.min_diameter !== null && (
                <div className="flex flex-row items-center gap-6">
                  <Label label="Min Diameter">
                    <div className="flex flex-row items-center gap-4">
                      <Icon name="lu:ArrowDown" className="size-7" />
                      <div className="flex flex-row items-center gap-2">
                        <span className="font-mono text-4xl font-bold">
                          {minMaxDiameter.data.min_diameter.toFixed(3)}
                        </span>
                        <span>mm</span>
                      </div>
                    </div>
                  </Label>
                </div>
              )}
              {minMaxDiameter.data.max_diameter !== null && (
                <div className="flex flex-row items-center gap-6">
                  <Label label="Max Diameter">
                    <div className="flex flex-row items-center gap-4">
                      <Icon name="lu:ArrowUp" className="size-7" />
                      <div className="flex flex-row items-center gap-2">
                        <span className="font-mono text-4xl font-bold">
                          {minMaxDiameter.data.max_diameter.toFixed(3)}
                        </span>
                        <span>mm</span>
                      </div>
                    </div>
                  </Label>
                </div>
              )}
            </>
          )}
        </ControlCard>
        <ControlCard title="Settings">
          <Label label="Set Target Diameter">
            <EditValue
              title="Set Target Diameter"
              value={targetDiameter}
              unit="mm"
              step={0.01}
              min={0}
              max={5}
              renderValue={(value) => value.toFixed(2)}
              onChange={(val) => {
                if (val < lowerTolerance) {
                  setLowerTolerance(val);
                }
                setTargetDiameter(val);
              }}
              defaultValue={defaultState?.laser_state.target_diameter}
            />
          </Label>
          <Label label="Set Lower Tolerance">
            <EditValue
              title="Set Lower Tolerance"
              value={lowerTolerance}
              unit="mm"
              step={0.01}
              min={0}
              max={Math.min(targetDiameter, 1)}
              renderValue={(value) => value.toFixed(2)}
              onChange={(val) => setLowerTolerance(val)}
              defaultValue={defaultState?.laser_state.lower_tolerance}
            />
          </Label>
          <Label label="Set Higher Tolerance">
            <EditValue
              title="Set Higher Tolerance"
              value={higherTolerance}
              unit="mm"
              step={0.01}
              min={0}
              max={1}
              renderValue={(value) => value.toFixed(2)}
              onChange={(val) => setHigherTolerance(val)}
              defaultValue={defaultState?.laser_state.higher_tolerance}
            />
          </Label>
          <Label label="Min/Max Tracking Timeframe">
            <EditValue
              title="Set Min/Max Tracking Timeframe"
              value={minMaxTimeframeMinutes}
              step={1}
              min={1}
              max={300} // 5 hours
              renderValue={(value) => `${value} min`}
              onChange={(val) => setMinMaxTimeframe(val)}
              defaultValue={defaultState?.laser_state.min_max_timeframe_minutes}
            />
          </Label>
        </ControlCard>
      </ControlGrid>
    </Page>
  );
}
