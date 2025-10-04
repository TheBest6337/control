import { ipcMain } from "electron";
import {
  UPDATE_CANCEL,
  UPDATE_END,
  UPDATE_EXECUTE,
  UPDATE_LOG,
  UPDATE_PROGRESS,
  UpdateProgressData,
} from "./update-channels";
import { spawn, ChildProcess } from "child_process";
import tkill from "@jub3i/tree-kill";
import { existsSync, rmSync } from "fs";

type UpdateExecuteListenerParams = {
  githubRepoOwner: string;
  githubRepoName: string;
  githubToken?: string;
  tag?: string;
  branch?: string;
  commit?: string;
};

// Store reference to current update process for cancellation
let currentUpdateProcess: ChildProcess | null = null;

export function addUpdateEventListeners() {
  ipcMain.handle(
    UPDATE_EXECUTE,
    async (event, params: UpdateExecuteListenerParams) => {
      update(event, params)
        .then(() => {
          currentUpdateProcess = null;
          event.sender.send(
            UPDATE_END,
            terminalSuccess("Update completed successfully!"),
          );
        })
        .catch((error) => {
          currentUpdateProcess = null;
          event.sender.send(
            UPDATE_END,
            terminalError(`Update failed: ${error.message}`),
          );
        });
    },
  );

  ipcMain.handle(UPDATE_CANCEL, async (event) => {
    if (currentUpdateProcess) {
      event.sender.send(
        UPDATE_LOG,
        terminalInfo("Cancelling update process..."),
      );

      // Kill the process and all its child processes using tree-kill
      try {
        const pid = currentUpdateProcess.pid!;

        // Use tree-kill to properly terminate the entire process tree
        // First try graceful termination with SIGTERM (default signal)
        await new Promise<void>((resolve, reject) => {
          tkill(pid, (err) => {
            if (err) {
              // If graceful termination fails, force kill with SIGKILL
              tkill(pid, "SIGKILL", (killErr) => {
                if (killErr) {
                  reject(killErr);
                } else {
                  resolve();
                }
              });
            } else {
              resolve();
            }
          });
        });

        currentUpdateProcess = null;
        event.sender.send(UPDATE_END, terminalInfo("Update process cancelled"));
        return { success: true };
      } catch (error: any) {
        event.sender.send(
          UPDATE_LOG,
          terminalError(`Error cancelling process: ${error.message}`),
        );
        return { success: false, error: error.message };
      }
    } else {
      event.sender.send(UPDATE_LOG, terminalInfo("No update process running"));
      return { success: false, error: "No update process running" };
    }
  });
}

async function update(
  event: Electron.IpcMainInvokeEvent,
  params: UpdateExecuteListenerParams,
): Promise<void> {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        const {
          githubRepoOwner,
          githubRepoName,
          githubToken,
          tag,
          branch,
          commit,
        } = params;

        // Reset NixOS build progress tracking
        nixosBuildPhaseProgress = {
          totalDerivations: 0,
          builtDerivations: 0,
          currentPhase: "",
          maxPercent: 0,
        };

        // Implement your update logic here
        console.log("Update parameters:", {
          githubRepoOwner,
          githubRepoName,
          githubToken,
          tag,
          branch,
          commit,
        });

        const qitechControlEnv = process.env.QITECH_CONTROL_ENV;
        const homeDir =
          qitechControlEnv === "control-os" ? "/home/qitech" : process.env.HOME;
        if (!homeDir) {
          event.sender.send(
            UPDATE_LOG,
            terminalColor("red", terminalError("Home directory not found")),
          );
          return;
        }

        // 1. first make sure the clone path is empty by deleting it if it containsa .git folder
        event.sender.send(UPDATE_PROGRESS, {
          type: "step-change",
          step: "clear-repo",
          status: "in-progress",
        } as UpdateProgressData);

        const repoDir = `${homeDir}/${githubRepoName}`;
        const clearResult = await clearRepoDirectory(
          `${homeDir}/${githubRepoName}`,
          event,
        );
        if (!clearResult.success) {
          event.sender.send(UPDATE_LOG, clearResult.error);
          return;
        }

        // Mark clear-repo as completed
        event.sender.send(UPDATE_PROGRESS, {
          type: "step-change",
          step: "clear-repo",
          status: "completed",
        } as UpdateProgressData);

        // 2. clone the repository
        event.sender.send(UPDATE_PROGRESS, {
          type: "step-change",
          step: "clone-repo",
          status: "in-progress",
        } as UpdateProgressData);
        const cloneResult = await cloneRepository(
          {
            githubRepoOwner,
            githubRepoName,
            githubToken,
            tag,
            branch,
            commit,
          },
          event,
        );
        if (!cloneResult.success) {
          event.sender.send(UPDATE_LOG, cloneResult.error);
          return;
        }

        // Mark clone-repo as completed
        event.sender.send(UPDATE_PROGRESS, {
          type: "step-change",
          step: "clone-repo",
          status: "completed",
        } as UpdateProgressData);

        // 3. make the nixos-install.sh script executable
        event.sender.send(UPDATE_PROGRESS, {
          type: "step-change",
          step: "prepare",
          status: "in-progress",
        } as UpdateProgressData);

        const chmodResult = await runCommand(
          "chmod",
          ["+x", "nixos-install.sh"],
          repoDir,
          event,
        );
        if (!chmodResult.success) {
          event.sender.send(UPDATE_LOG, chmodResult.error);
          return;
        }

        // Mark prepare as completed
        event.sender.send(UPDATE_PROGRESS, {
          type: "step-change",
          step: "prepare",
          status: "completed",
        } as UpdateProgressData);

        // 4. run the nixos-install.sh script
        event.sender.send(UPDATE_PROGRESS, {
          type: "step-change",
          step: "nixos-build",
          status: "in-progress",
        } as UpdateProgressData);
        const installResult = await runCommand(
          "./nixos-install.sh",
          [],
          repoDir,
          event,
        );
        if (!installResult.success) {
          event.sender.send(UPDATE_LOG, installResult.error);
          return;
        }

        // Mark nixos-build as completed
        event.sender.send(UPDATE_PROGRESS, {
          type: "step-change",
          step: "nixos-build",
          status: "completed",
        } as UpdateProgressData);

        // Mark finalize as completed (bootloader update is part of nixos-install.sh)
        event.sender.send(UPDATE_PROGRESS, {
          type: "step-change",
          step: "finalize",
          status: "completed",
        } as UpdateProgressData);

        resolve();
      } catch (error: any) {
        reject(error);
      }
    })();
  });
}

type CloneRepositoryParams = {
  githubRepoOwner: string;
  githubRepoName: string;
  githubToken?: string;
  tag?: string;
  branch?: string;
  commit?: string;
};

async function clearRepoDirectory(
  repoDir: string,
  event: Electron.IpcMainInvokeEvent,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if the repo directory exists
    if (existsSync(repoDir)) {
      // If it exists, delete the repo directory
      rmSync(repoDir, { recursive: true, force: true });
      event.sender.send(
        UPDATE_LOG,
        terminalSuccess(`Deleted existing repository at ${repoDir}`),
      );
    } else {
      event.sender.send(
        UPDATE_LOG,
        terminalInfo(
          `No existing repository found at ${repoDir}, nothing to delete`,
        ),
      );
    }
    return { success: true };
  } catch (error: any) {
    event.sender.send(UPDATE_LOG, terminalError(`Error: ${error.toString()}`));
    return { success: false, error: error.toString() };
  }
}

async function cloneRepository(
  params: CloneRepositoryParams,
  event: Electron.IpcMainInvokeEvent,
): Promise<{ success: boolean; error?: string }> {
  const { githubRepoOwner, githubRepoName, githubToken, tag, branch, commit } =
    params;

  const qitechControlEnv = process.env.QITECH_CONTROL_ENV;
  const homeDir = qitechControlEnv ? "/home/qitech" : process.env.HOME;

  if (!homeDir) {
    return { success: false, error: terminalError("Home directory not found") };
  }

  // Construct repository URL
  const repoUrl = githubToken
    ? `https://${githubToken}@github.com/${githubRepoOwner}/${githubRepoName}.git`
    : `https://github.com/${githubRepoOwner}/${githubRepoName}.git`;

  // Determine clone arguments based on whether tag, branch, or commit is specified
  const cloneArgs = ["clone", "--progress", repoUrl];

  if (tag) {
    // Clone a specific tag
    cloneArgs.push("--branch", tag, "--single-branch");
    event.sender.send(UPDATE_LOG, terminalInfo(`Cloning tag: ${tag}`));
  } else if (branch) {
    // Clone a specific branch
    cloneArgs.push("--branch", branch, "--single-branch");
    event.sender.send(UPDATE_LOG, terminalInfo(`Cloning branch: ${branch}`));
  } else if (commit) {
    // For commit, we need to clone first, then checkout the specific commit
    event.sender.send(
      UPDATE_LOG,
      terminalInfo(`Cloning repository, will checkout commit: ${commit}`),
    );
  } else {
    return {
      success: false,
      error: terminalError("No specific version specified!"),
    };
  }

  const cmd1 = await runCommand("git", cloneArgs, homeDir, event);

  if (!cmd1.success) {
    return {
      success: false,
      error: terminalError("Failed to clone repository"),
    };
  }

  // If commit is specified, checkout the specific commit
  if (commit && cmd1.success) {
    const repoDir = `${homeDir}/${githubRepoName}`;

    const cmd2 = await runCommand("git", ["checkout", commit], repoDir, event);

    if (!cmd2.success) {
      return {
        success: false,
        error: terminalError(`Failed to checkout commit: ${commit}`),
      };
    }

    event.sender.send(
      UPDATE_LOG,
      terminalSuccess(`Successfully checked out commit: ${commit}`),
    );
  }
  event.sender.send(
    UPDATE_LOG,
    terminalSuccess("Repository cloned successfully"),
  );
  return { success: true, error: undefined };
}

async function runCommand(
  cmd: string,
  args: string[],
  workingDir: string,
  event: Electron.IpcMainInvokeEvent,
): Promise<{ success: boolean; error?: string }> {
  try {
    const completeCommand = `${cmd} ${args.join(" ")}`;
    const workingDirText = terminalGray(workingDir);
    event.sender.send(
      UPDATE_LOG,
      `🚀 ${workingDirText} ${terminalColor("blue", completeCommand)}`,
    );

    const childProcess = spawn(cmd, args, {
      cwd: workingDir,
    });

    // Store reference to current process for cancellation
    currentUpdateProcess = childProcess;

    // Stream stdout logs back to renderer
    childProcess.stdout.on("data", (data) => {
      const log = data.toString();
      console.log(log);
      event.sender.send(UPDATE_LOG, log);

      // Parse NixOS build output
      if (cmd.includes("nixos-install.sh") || cmd === "nixos-rebuild") {
        parseNixosBuildOutput(log, event);
      }
    });

    // Stream stderr logs back to renderer
    childProcess.stderr.on("data", (data) => {
      const log = data.toString();
      console.error(log);
      event.sender.send(UPDATE_LOG, log);

      // Git outputs progress to stderr
      if (cmd === "git" && args.includes("--progress")) {
        parseGitProgress(log, event);
      }

      // NixOS also outputs some info to stderr
      if (cmd.includes("nixos-install.sh") || cmd === "nixos-rebuild") {
        parseNixosBuildOutput(log, event);
      }
    });

    // Handle process completion
    return new Promise((resolve, reject) => {
      childProcess.on("close", (code, signal) => {
        // Clear process reference when completed
        if (currentUpdateProcess === childProcess) {
          currentUpdateProcess = null;
        }

        if (signal === "SIGTERM" || signal === "SIGKILL") {
          event.sender.send(UPDATE_LOG, terminalInfo("Command was cancelled"));
          reject({
            success: false,
            error: "Command was cancelled",
          });
        } else if (code === 0) {
          event.sender.send(
            UPDATE_LOG,
            terminalSuccess("Command completed successfully"),
          );
          resolve({ success: true, error: undefined });
        } else {
          event.sender.send(
            UPDATE_LOG,
            terminalError(`Command failed with code ${code}`),
          );
          reject({
            success: false,
            error: terminalError(code?.toString() ?? "NO_CODE"),
          });
        }
      });

      childProcess.on("error", (err) => {
        // Clear process reference on error
        if (currentUpdateProcess === childProcess) {
          currentUpdateProcess = null;
        }

        event.sender.send(
          UPDATE_LOG,
          terminalError(`Command error: ${err.message}`),
        );
        reject({ success: false, error: err.message });
      });
    });
  } catch (error: any) {
    event.sender.send(UPDATE_LOG, terminalError(`Error: ${error.toString()}`));
    return { success: false, error: error.toString() };
  }
}

function parseGitProgress(
  output: string,
  event: Electron.IpcMainInvokeEvent,
): void {
  // Git progress format: "Receiving objects: 45% (234/520)"
  // or "Resolving deltas: 100% (150/150)"
  const receivingMatch = output.match(/Receiving objects:\s*(\d+)%/);
  const resolvingMatch = output.match(/Resolving deltas:\s*(\d+)%/);

  if (receivingMatch) {
    const percent = parseInt(receivingMatch[1], 10);
    event.sender.send(UPDATE_PROGRESS, {
      type: "git-progress",
      gitPercent: percent * 0.8, // Receiving is 80% of clone
    } as UpdateProgressData);
  } else if (resolvingMatch) {
    const percent = parseInt(resolvingMatch[1], 10);
    event.sender.send(UPDATE_PROGRESS, {
      type: "git-progress",
      gitPercent: 80 + percent * 0.2, // Resolving is last 20%
    } as UpdateProgressData);
  }
}

// Track NixOS build progress
let nixosBuildPhaseProgress = {
  totalDerivations: 0,
  builtDerivations: 0,
  currentPhase: "",
  maxPercent: 0, // Track max to prevent backward movement
};

function parseNixosBuildOutput(
  output: string,
  event: Electron.IpcMainInvokeEvent,
): void {
  // Track derivations to build - these appear at the start
  // Format: "these N derivations will be built:"
  const derivationsMatch = output.match(
    /these (\d+) derivations? will be built/i,
  );
  if (derivationsMatch) {
    nixosBuildPhaseProgress.totalDerivations = parseInt(
      derivationsMatch[1],
      10,
    );
    nixosBuildPhaseProgress.builtDerivations = 0;
    nixosBuildPhaseProgress.maxPercent = 0; // Reset max percent tracker
    event.sender.send(UPDATE_PROGRESS, {
      type: "nixos-progress",
      nixosPhase: `Preparing to build ${nixosBuildPhaseProgress.totalDerivations} packages...`,
      nixosPercent: 0,
    } as UpdateProgressData);
    return;
  }

  // Track paths to copy/fetch
  const pathsMatch = output.match(
    /these (\d+) paths? will be (?:fetched|copied)/i,
  );
  if (pathsMatch) {
    const pathCount = parseInt(pathsMatch[1], 10);
    const percent = Math.max(5, nixosBuildPhaseProgress.maxPercent);
    nixosBuildPhaseProgress.maxPercent = percent;
    
    event.sender.send(UPDATE_PROGRESS, {
      type: "nixos-progress",
      nixosPhase: `Fetching ${pathCount} dependencies...`,
      nixosPercent: percent,
    } as UpdateProgressData);
    return;
  }

  // Detect various NixOS build phases
  if (output.includes("copying path") || output.includes("copying ")) {
    // Only update if this moves progress forward
    const percent = Math.max(10, nixosBuildPhaseProgress.maxPercent);
    nixosBuildPhaseProgress.maxPercent = percent;
    
    event.sender.send(UPDATE_PROGRESS, {
      type: "nixos-progress",
      nixosPhase: "Copying dependencies...",
      nixosPercent: percent,
    } as UpdateProgressData);
  } else if (
    output.includes("building '/nix/store/") ||
    output.includes("building /nix/store/")
  ) {
    // Extract what's being built
    const buildMatch = output.match(
      /building ['"]?\/nix\/store\/[^-]+-([^'"]+)/,
    );
    const packageName = buildMatch ? buildMatch[1].replace(".drv", "") : "";

    // Increment built derivations counter
    nixosBuildPhaseProgress.builtDerivations++;

    // Calculate progress based on derivations built
    let percent = 15; // Start after dependency copying
    if (nixosBuildPhaseProgress.totalDerivations > 0) {
      // Map derivation progress to 15-85% of total progress
      const derivationProgress =
        nixosBuildPhaseProgress.builtDerivations /
        nixosBuildPhaseProgress.totalDerivations;
      percent = 15 + Math.floor(derivationProgress * 70);
    }

    // Only move forward, never backward (prevents issues with micro sectors)
    percent = Math.max(percent, nixosBuildPhaseProgress.maxPercent);
    nixosBuildPhaseProgress.maxPercent = percent;

    event.sender.send(UPDATE_PROGRESS, {
      type: "nixos-progress",
      nixosPhase: packageName
        ? `Building ${packageName}... (${nixosBuildPhaseProgress.builtDerivations}/${nixosBuildPhaseProgress.totalDerivations})`
        : "Building packages...",
      nixosPercent: percent,
      currentDerivation: packageName,
    } as UpdateProgressData);
  } else if (output.includes("unpacking") || output.includes("Unpacking")) {
    event.sender.send(UPDATE_PROGRESS, {
      type: "nixos-progress",
      nixosPhase: "Unpacking sources...",
    } as UpdateProgressData);
  } else if (output.includes("patching") || output.includes("Patching")) {
    event.sender.send(UPDATE_PROGRESS, {
      type: "nixos-progress",
      nixosPhase: "Patching sources...",
    } as UpdateProgressData);
  } else if (output.includes("configuring") || output.includes("Configuring")) {
    event.sender.send(UPDATE_PROGRESS, {
      type: "nixos-progress",
      nixosPhase: "Configuring build...",
    } as UpdateProgressData);
  } else if (
    output.includes("building") &&
    !output.includes("building '/nix/store/")
  ) {
    event.sender.send(UPDATE_PROGRESS, {
      type: "nixos-progress",
      nixosPhase: "Compiling...",
    } as UpdateProgressData);
  } else if (output.includes("installing") || output.includes("Installing")) {
    const percent = Math.max(88, nixosBuildPhaseProgress.maxPercent);
    nixosBuildPhaseProgress.maxPercent = percent;
    
    event.sender.send(UPDATE_PROGRESS, {
      type: "nixos-progress",
      nixosPhase: "Installing packages...",
      nixosPercent: percent,
    } as UpdateProgressData);
  } else if (
    output.includes("post-installation") ||
    output.includes("post-install")
  ) {
    const percent = Math.max(92, nixosBuildPhaseProgress.maxPercent);
    nixosBuildPhaseProgress.maxPercent = percent;
    
    event.sender.send(UPDATE_PROGRESS, {
      type: "nixos-progress",
      nixosPhase: "Running post-installation...",
      nixosPercent: percent,
    } as UpdateProgressData);
  } else if (
    output.includes("updating GRUB") ||
    output.includes("installing bootloader") ||
    output.includes("updating bootloader")
  ) {
    const percent = Math.max(95, nixosBuildPhaseProgress.maxPercent);
    nixosBuildPhaseProgress.maxPercent = percent;
    
    event.sender.send(UPDATE_PROGRESS, {
      type: "step-change",
      step: "finalize",
      status: "in-progress",
    } as UpdateProgressData);
    event.sender.send(UPDATE_PROGRESS, {
      type: "nixos-progress",
      nixosPhase: "Updating bootloader...",
      nixosPercent: percent,
    } as UpdateProgressData);
  } else if (
    output.includes("building the system configuration") ||
    output.includes("building system")
  ) {
    const percent = Math.max(12, nixosBuildPhaseProgress.maxPercent);
    nixosBuildPhaseProgress.maxPercent = percent;
    
    event.sender.send(UPDATE_PROGRESS, {
      type: "nixos-progress",
      nixosPhase: "Building system configuration...",
      nixosPercent: percent,
    } as UpdateProgressData);
  }
}

function terminalColor(
  color: "blue" | "green" | "red" | "cyan" | "gray",
  text: string,
): string {
  const colors = {
    blue: "\x1b[34m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m",
  };
  return `${colors[color]}${text}\x1b[0m`;
}

function terminalError(text: string): string {
  return terminalColor("red", "💥 " + text);
}

function terminalSuccess(text: string): string {
  return terminalColor("green", "✅ " + text);
}

function terminalInfo(text: string): string {
  return terminalColor("cyan", "📝 " + text);
}

function terminalGray(text: string): string {
  return terminalColor("gray", text);
}
