import { create } from "zustand";
import { produce } from "immer";
import {
  UpdateStep,
  UpdateStepName,
  UpdateStepStatus,
} from "@/helpers/ipc/update/update-channels";

export type UpdateInfo = {
  githubRepoOwner: string;
  githubRepoName: string;
  githubToken?: string;
  tag?: string;
  branch?: string;
  commit?: string;
};

// Historical duration tracking
type StepDuration = {
  stepName: UpdateStepName;
  duration: number; // in seconds
  timestamp: number;
};

const STORAGE_KEY = "update-step-durations";
const MAX_HISTORY_ENTRIES = 10;

// Load historical durations from localStorage
const loadHistoricalDurations = (): StepDuration[] => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

// Save duration to localStorage
const saveStepDuration = (stepName: UpdateStepName, duration: number) => {
  const history = loadHistoricalDurations();
  history.push({
    stepName,
    duration,
    timestamp: Date.now(),
  });

  // Keep only last MAX_HISTORY_ENTRIES entries per step
  const filtered = history.slice(-MAX_HISTORY_ENTRIES * 6); // 6 steps
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
};

// Calculate average duration for a step
const getAverageDuration = (stepName: UpdateStepName): number => {
  const history = loadHistoricalDurations();
  const stepHistory = history.filter((h) => h.stepName === stepName);

  if (stepHistory.length === 0) {
    // Return default estimates if no history
    const defaults: Record<UpdateStepName, number> = {
      "clear-repo": 2,
      "clone-repo": 120,
      prepare: 3,
      "nixos-build": 600,
      finalize: 20,
    };
    return defaults[stepName];
  }

  const sum = stepHistory.reduce((acc, h) => acc + h.duration, 0);
  return sum / stepHistory.length;
};

export type UpdateState = {
  isUpdating: boolean;
  terminalLines: string[];
  currentUpdateInfo: UpdateInfo | null;
  steps: UpdateStep[];
  currentStepIndex: number;
  gitProgress: number; // 0-100
  nixosProgress: number; // 0-100
  nixosPhase: string;
  estimatedTimeRemaining: number | null; // in seconds
};

export type UpdateActions = {
  setUpdateInfo: (info: UpdateInfo) => void;
  startUpdate: () => void;
  stopUpdate: () => void;
  addTerminalLine: (line: string) => void;
  clearTerminalLines: () => void;
  resetUpdateState: () => void;
  initializeSteps: () => void;
  setStepStatus: (stepName: UpdateStepName, status: UpdateStepStatus) => void;
  setGitProgress: (percent: number) => void;
  setNixosProgress: (percent: number) => void;
  setNixosPhase: (phase: string) => void;
  updateTimeEstimate: () => void;
};

export type UpdateStore = UpdateState & UpdateActions;

const createInitialSteps = (): UpdateStep[] => [
  {
    name: "clear-repo",
    displayName: "Clear old repository",
    status: "pending",
    estimatedDuration: getAverageDuration("clear-repo"),
  },
  {
    name: "clone-repo",
    displayName: "Clone repository",
    status: "pending",
    estimatedDuration: getAverageDuration("clone-repo"),
  },
  {
    name: "prepare",
    displayName: "Prepare installation",
    status: "pending",
    estimatedDuration: getAverageDuration("prepare"),
  },
  {
    name: "nixos-build",
    displayName: "Build NixOS system",
    status: "pending",
    estimatedDuration: getAverageDuration("nixos-build"),
  },
  {
    name: "finalize",
    displayName: "Configure bootloader",
    status: "pending",
    estimatedDuration: getAverageDuration("finalize"),
  },
];

const initialState: UpdateState = {
  isUpdating: false,
  terminalLines: [],
  currentUpdateInfo: null,
  steps: createInitialSteps(),
  currentStepIndex: -1,
  gitProgress: 0,
  nixosProgress: 0,
  nixosPhase: "",
  estimatedTimeRemaining: null,
};

export const useUpdateStore = create<UpdateStore>((set) => ({
  ...initialState,

  setUpdateInfo: (info) =>
    set(
      produce((state: UpdateState) => {
        // Only allow setting update info if not currently updating
        if (!state.isUpdating) {
          // Check if the update target has changed
          const hasTargetChanged =
            !state.currentUpdateInfo ||
            state.currentUpdateInfo.githubRepoOwner !== info.githubRepoOwner ||
            state.currentUpdateInfo.githubRepoName !== info.githubRepoName ||
            state.currentUpdateInfo.tag !== info.tag ||
            state.currentUpdateInfo.branch !== info.branch ||
            state.currentUpdateInfo.commit !== info.commit;

          // Clear terminal lines if target changed
          if (hasTargetChanged) {
            state.terminalLines = [];
          }

          state.currentUpdateInfo = info;
        }
      }),
    ),

  startUpdate: () =>
    set(
      produce((state: UpdateState) => {
        state.isUpdating = true;
        state.terminalLines = [];
      }),
    ),

  stopUpdate: () =>
    set(
      produce((state: UpdateState) => {
        state.isUpdating = false;
      }),
    ),

  addTerminalLine: (line) =>
    set(
      produce((state: UpdateState) => {
        console.log(state.terminalLines);

        const lastLine = state.terminalLines[state.terminalLines.length - 1];
        if (line !== lastLine) {
          state.terminalLines.push(line);

          // Keep only last 10000 lines to prevent memory issues
          if (state.terminalLines.length > 10000) {
            state.terminalLines.splice(0, state.terminalLines.length - 10000);
          }
        }
      }),
    ),

  clearTerminalLines: () =>
    set(
      produce((state: UpdateState) => {
        state.terminalLines = [];
      }),
    ),

  resetUpdateState: () =>
    set(
      produce((state: UpdateState) => {
        state.isUpdating = false;
        state.terminalLines = [];
        state.currentUpdateInfo = null;
        state.steps = createInitialSteps();
        state.currentStepIndex = -1;
        state.gitProgress = 0;
        state.nixosProgress = 0;
        state.nixosPhase = "";
        state.estimatedTimeRemaining = null;
      }),
    ),

  initializeSteps: () =>
    set(
      produce((state: UpdateState) => {
        state.steps = createInitialSteps();
        state.currentStepIndex = -1;
        state.gitProgress = 0;
        state.nixosProgress = 0;
        state.nixosPhase = "";
        state.estimatedTimeRemaining = null;
      }),
    ),

  setStepStatus: (stepName: UpdateStepName, status: UpdateStepStatus) =>
    set(
      produce((state: UpdateState) => {
        const stepIndex = state.steps.findIndex((s) => s.name === stepName);
        if (stepIndex === -1) return;

        const step = state.steps[stepIndex];
        const now = Date.now();

        if (status === "in-progress" && step.status === "pending") {
          step.startTime = now;
          state.currentStepIndex = stepIndex;
        } else if (
          (status === "completed" || status === "failed") &&
          step.status === "in-progress" &&
          step.startTime
        ) {
          step.endTime = now;
          const duration = (now - step.startTime) / 1000; // convert to seconds
          saveStepDuration(stepName, duration);
        }

        step.status = status;
      }),
    ),

  setGitProgress: (percent: number) =>
    set(
      produce((state: UpdateState) => {
        state.gitProgress = Math.min(100, Math.max(0, percent));
      }),
    ),

  setNixosProgress: (percent: number) =>
    set(
      produce((state: UpdateState) => {
        state.nixosProgress = Math.min(100, Math.max(0, percent));
      }),
    ),

  setNixosPhase: (phase: string) =>
    set(
      produce((state: UpdateState) => {
        state.nixosPhase = phase;
      }),
    ),

  updateTimeEstimate: () =>
    set(
      produce((state: UpdateState) => {
        const completedSteps = state.steps.filter(
          (s) => s.status === "completed",
        );
        const remainingSteps = state.steps.filter(
          (s) => s.status === "pending" || s.status === "in-progress",
        );

        if (completedSteps.length === 0) {
          // No data yet, use estimated durations
          state.estimatedTimeRemaining = remainingSteps.reduce(
            (acc, s) => acc + s.estimatedDuration,
            0,
          );
          return;
        }

        // Calculate average speed factor from completed steps
        let totalActual = 0;
        let totalEstimated = 0;

        completedSteps.forEach((step) => {
          if (step.startTime && step.endTime) {
            const actual = (step.endTime - step.startTime) / 1000;
            totalActual += actual;
            totalEstimated += step.estimatedDuration;
          }
        });

        const speedFactor =
          totalEstimated > 0 ? totalActual / totalEstimated : 1.0;

        // Calculate remaining time with speed factor adjustment
        let remainingTime = 0;
        remainingSteps.forEach((step) => {
          if (step.status === "in-progress" && step.startTime) {
            // For current step, calculate based on elapsed time
            const elapsed = (Date.now() - step.startTime) / 1000;
            const estimated = step.estimatedDuration * speedFactor;
            remainingTime += Math.max(0, estimated - elapsed);
          } else {
            remainingTime += step.estimatedDuration * speedFactor;
          }
        });

        state.estimatedTimeRemaining = Math.ceil(remainingTime);
      }),
    ),
}));
