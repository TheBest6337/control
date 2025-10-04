import { Alert } from "@/components/Alert";
import { Page } from "@/components/Page";
import { SectionTitle } from "@/components/SectionTitle";
import { Terminal } from "@/components/Terminal";
import { TouchButton } from "@/components/touch/TouchButton";
import { UpdateProgress } from "@/components/UpdateProgress";
import { updateExecute, updateCancelWithStore } from "@/helpers/update_helpers";
import { useUpdateStore } from "@/stores/updateStore";
import { useSearch } from "@tanstack/react-router";
import React, { useEffect } from "react";
import { toast } from "sonner";
import type { UpdateProgressData } from "@/helpers/ipc/update/update-channels";

export function UpdateExecutePage() {
  const search = useSearch({
    from: "/_sidebar/setup/update/execute",
  });

  const {
    isUpdating,
    terminalLines,
    currentUpdateInfo,
    steps,
    currentStepIndex,
    gitProgress,
    nixosProgress,
    nixosPhase,
    estimatedTimeRemaining,
    setUpdateInfo,
    startUpdate,
    stopUpdate,
    addTerminalLine,
    clearTerminalLines,
    resetUpdateState,
    initializeSteps,
    setStepStatus,
    setGitProgress,
    setNixosProgress,
    setNixosPhase,
    updateTimeEstimate,
  } = useUpdateStore();

  // Set update info from search params when component mounts or search changes
  useEffect(() => {
    if (!isUpdating && search) {
      setUpdateInfo({
        githubRepoOwner: search.githubRepoOwner,
        githubRepoName: search.githubRepoName,
        githubToken: search.githubToken || undefined,
        tag: search.tag,
        branch: search.branch,
        commit: search.commit,
      });
    }
  }, [search, isUpdating, setUpdateInfo]);

  const handleProgressUpdate = (data: UpdateProgressData) => {
    if (data.type === "step-change" && data.step) {
      // Use the status from the progress data, default to "in-progress" if not specified
      const status = data.status || "in-progress";
      setStepStatus(data.step, status);
      updateTimeEstimate();
    } else if (data.type === "git-progress" && data.gitPercent !== undefined) {
      setGitProgress(data.gitPercent);
    } else if (data.type === "nixos-progress") {
      if (data.nixosPhase) {
        setNixosPhase(data.nixosPhase);
      }
      if (data.nixosPercent !== undefined) {
        setNixosProgress(data.nixosPercent);
      }
      // Update time estimate as nixos build progresses
      updateTimeEstimate();
    }
  };

  const handleClick = async () => {
    const updateInfo = currentUpdateInfo || {
      githubRepoOwner: search.githubRepoOwner,
      githubRepoName: search.githubRepoName,
      githubToken: search.githubToken || undefined,
      tag: search.tag,
      branch: search.branch,
      commit: search.commit,
    };

    initializeSteps();
    startUpdate();

    const res = await updateExecute(
      updateInfo,
      addTerminalLine,
      handleProgressUpdate,
    );

    // Mark all steps as completed on success
    if (res.success) {
      steps.forEach((step) => {
        if (step.status === "in-progress") {
          setStepStatus(step.name, "completed");
        }
      });
    }

    stopUpdate();

    if (res.success) {
      toast.success("Update applied successfully");
    } else {
      toast.error("Update failed: " + res.error);
    }
  };

  const handleCancel = async () => {
    if (!isUpdating) return;

    try {
      const res = await updateCancelWithStore();
      if (res.success) {
        toast.info("Update cancelled successfully");
        clearTerminalLines();
      } else {
        toast.error("Failed to cancel update: " + res.error);
      }
    } catch (error: any) {
      toast.error("Failed to cancel update: " + error.message);
    }
    resetUpdateState();
  };

  return (
    <Page>
      <SectionTitle title="Apply Update" />

      <div className="flex flex-row gap-4">
        <TouchButton
          className="w-max"
          icon="lu:CircleFadingArrowUp"
          onClick={handleClick}
          disabled={isUpdating}
          isLoading={isUpdating}
        >
          Apply Update
        </TouchButton>
        {isUpdating && (
          <TouchButton
            className="w-max"
            icon="lu:X"
            onClick={handleCancel}
            variant="destructive"
          >
            Cancel Update
          </TouchButton>
        )}
      </div>

      {currentUpdateInfo && (
        <Alert title="Update Information" variant="info">
          <div className="space-y-3">
            <div className="space-y-1 text-sm">
              {currentUpdateInfo.tag && (
                <div>
                  <span className="font-medium">Tag:</span>{" "}
                  <span className="font-mono">{currentUpdateInfo.tag}</span>
                </div>
              )}
              {currentUpdateInfo.branch && (
                <div>
                  <span className="font-medium">Branch:</span>{" "}
                  <span className="font-mono">{currentUpdateInfo.branch}</span>
                </div>
              )}
              {currentUpdateInfo.commit && (
                <div>
                  <span className="font-medium">Commit:</span>{" "}
                  <span className="font-mono">
                    {currentUpdateInfo.commit.substring(0, 8)}
                  </span>
                </div>
              )}
            </div>
          </div>
        </Alert>
      )}

      {/* Progress Indicator */}
      {isUpdating && (
        <UpdateProgress
          steps={steps}
          currentStepIndex={currentStepIndex}
          gitProgress={gitProgress}
          nixosProgress={nixosProgress}
          nixosPhase={nixosPhase}
          estimatedTimeRemaining={estimatedTimeRemaining}
        />
      )}

      <Terminal
        lines={terminalLines}
        className="h-160"
        exportPrefix="qitech_control_server_update"
      />
    </Page>
  );
}
