export const UPDATE_EXECUTE = "update:execute";
export const UPDATE_LOG = "update:log";
export const UPDATE_END = "update:end";
export const UPDATE_CANCEL = "update:cancel";
export const UPDATE_PROGRESS = "update:progress";

export type UpdateStepName =
  | "clear-repo"
  | "clone-repo"
  | "checkout"
  | "prepare"
  | "nixos-build"
  | "finalize";

export type UpdateStepStatus = "pending" | "in-progress" | "completed" | "failed";

export type UpdateStep = {
  name: UpdateStepName;
  displayName: string;
  status: UpdateStepStatus;
  startTime?: number;
  endTime?: number;
  estimatedDuration: number; // in seconds
};

export type UpdateProgressData = {
  type: "step-change" | "git-progress" | "nixos-progress";
  step?: UpdateStepName;
  status?: UpdateStepStatus;
  gitPercent?: number;
  nixosPhase?: string;
  currentDerivation?: string;
};
