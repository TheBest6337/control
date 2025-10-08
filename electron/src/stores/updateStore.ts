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

export type UpdateState = {
  isUpdating: boolean;
  terminalLines: string[];
  currentUpdateInfo: UpdateInfo | null;
  steps: UpdateStep[];
  currentStepIndex: number;
  gitProgress: number; // 0-100
  nixosProgress: number; // 0-100
  nixosPhase: string;
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
};

export type UpdateStore = UpdateState & UpdateActions;

const createInitialSteps = (): UpdateStep[] => [
  {
    name: "clear-repo",
    displayName: "Clear old repository",
    status: "pending",
  },
  {
    name: "clone-repo",
    displayName: "Clone repository",
    status: "pending",
  },
  {
    name: "prepare",
    displayName: "Prepare installation",
    status: "pending",
  },
  {
    name: "nixos-build",
    displayName: "Build NixOS system",
    status: "pending",
  },
  {
    name: "finalize",
    displayName: "Configure bootloader",
    status: "pending",
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
}));
