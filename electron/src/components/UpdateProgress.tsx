import { Icon, IconName } from "@/components/Icon";
import { UpdateStep } from "@/helpers/ipc/update/update-channels";
import React from "react";

type UpdateProgressProps = {
  steps: UpdateStep[];
  currentStepIndex: number;
  gitProgress?: number;
  nixosProgress?: number;
  nixosPhase?: string;
};

export function UpdateProgress({
  steps,
  currentStepIndex,
  gitProgress = 0,
  nixosProgress = 0,
  nixosPhase = "",
}: UpdateProgressProps) {
  // Track max progress to prevent backward movement
  const maxProgressRef = React.useRef(0);

  // Reset max progress when update starts fresh
  React.useEffect(() => {
    const allPending = steps.every((s) => s.status === "pending");
    if (allPending) {
      maxProgressRef.current = 0;
    }
  }, [steps]);

  // Calculate overall progress percentage
  const calculateOverallProgress = (): number => {
    const completedSteps = steps.filter((s) => s.status === "completed").length;
    const totalSteps = steps.length;

    if (completedSteps === totalSteps) return 100;
    if (completedSteps === 0 && currentStepIndex === -1) return 0;

    // Define step weights (should total 100%)
    const stepWeights: Record<string, number> = {
      "clear-repo": 5,
      "clone-repo": 20,
      prepare: 5,
      "nixos-build": 60,
      finalize: 10,
    };

    // Calculate progress based on completed and in-progress steps
    let progress = 0;

    steps.forEach((step, index) => {
      const weight = stepWeights[step.name] || 0;

      if (step.status === "completed") {
        // Add full weight for completed steps
        progress += weight;
      } else if (step.status === "in-progress") {
        // Add partial weight based on step progress
        if (step.name === "clone-repo" && gitProgress > 0) {
          // Git clone uses actual progress percentage
          progress += (gitProgress / 100) * weight;
        } else if (step.name === "nixos-build" && nixosProgress > 0) {
          // NixOS build uses actual progress percentage
          progress += (nixosProgress / 100) * weight;
        } else {
          // Other steps: assume 50% progress when in-progress
          progress += 0.5 * weight;
        }
      }
      // Pending steps contribute 0
    });

    // Ensure progress never goes backward
    progress = Math.max(progress, maxProgressRef.current);
    maxProgressRef.current = progress;

    return Math.min(100, Math.max(0, progress));
  };

  const overallProgress = calculateOverallProgress();

  const getStepIcon = (step: UpdateStep): IconName => {
    switch (step.status) {
      case "completed":
        return "lu:Check";
      case "in-progress":
        return "lu:Loader";
      case "failed":
        return "lu:X";
      default:
        return "lu:Circle";
    }
  };

  const getStepIconColor = (step: UpdateStep): string => {
    switch (step.status) {
      case "completed":
        return "text-green-600";
      case "in-progress":
        return "text-blue-600 animate-spin";
      case "failed":
        return "text-red-600";
      default:
        return "text-gray-300";
    }
  };

  const getStepTextColor = (step: UpdateStep): string => {
    switch (step.status) {
      case "completed":
        return "text-gray-700";
      case "in-progress":
        return "text-blue-700 font-semibold";
      case "failed":
        return "text-red-700";
      default:
        return "text-gray-400";
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Update Progress</h3>
        <div className="text-sm font-medium text-gray-600">
          {Math.round(overallProgress)}%
        </div>
      </div>

      {/* Overall Progress Bar */}
      <div className="mb-6">
        <div className="h-3 w-full overflow-hidden rounded-full bg-gray-200">
          <div
            className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all duration-500 ease-out"
            style={{ width: `${overallProgress}%` }}
          />
        </div>
      </div>

      {/* Step List */}
      <div className="space-y-3">
        {steps.map((step, index) => (
          <div key={step.name} className="flex items-start gap-3">
            {/* Step Icon */}
            <div className="mt-0.5">
              <Icon
                name={getStepIcon(step)}
                className={`size-5 ${getStepIconColor(step)}`}
              />
            </div>

            {/* Step Content */}
            <div className="flex-1">
              <div className={`text-sm ${getStepTextColor(step)}`}>
                {step.displayName}
              </div>

              {/* Git Clone Progress */}
              {step.name === "clone-repo" &&
                step.status === "in-progress" &&
                gitProgress > 0 && (
                  <div className="mt-1">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
                      <div
                        className="h-full rounded-full bg-blue-500 transition-all duration-300"
                        style={{ width: `${gitProgress}%` }}
                      />
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {Math.round(gitProgress)}%
                    </div>
                  </div>
                )}

              {/* NixOS Build Progress */}
              {step.name === "nixos-build" && step.status === "in-progress" && (
                <div className="mt-1 space-y-1">
                  {/* Show phase description */}
                  {nixosPhase && (
                    <div className="text-xs text-gray-600">{nixosPhase}</div>
                  )}
                  {/* Show progress bar if we have progress data */}
                  {nixosProgress > 0 && (
                    <div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
                        <div
                          className="h-full rounded-full bg-blue-500 transition-all duration-500"
                          style={{ width: `${nixosProgress}%` }}
                        />
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        {Math.round(nixosProgress)}%
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Step Duration (if completed) */}
            {step.status === "completed" && step.startTime && step.endTime && (
              <div className="text-xs text-gray-500">
                {Math.round((step.endTime - step.startTime) / 1000)}s
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Warning Message */}
      <div className="mt-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
        <div className="flex items-start gap-2">
          <Icon
            name="lu:TriangleAlert"
            className="mt-0.5 size-4 text-amber-600"
          />
          <div className="text-xs text-amber-800">
            <p className="font-semibold">Please do not close this window</p>
            <p className="mt-1">
              Keep the system powered on and connected to the internet. The
              system will automatically reboot when the update is complete.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
