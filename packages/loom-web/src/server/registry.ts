/**
 * Registry helpers for the multi-loom_home federation model.
 *
 * resolveActiveLoomHome: determines the effective loom_home for the served project.
 * buildUnifiedRegistry: merges active + machine-default registries into one Map.
 *
 * Owner: story-085-003
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PolicyEngine } from '@loom-ai/core';
export type { ProjectEntry } from '@loom-ai/core';
import type { ProjectEntry } from '@loom-ai/core';

/**
 * Resolves the active loom_home path.
 * Precedence: process.env.LOOM_HOME → policy.loom_home from loomDir/policy.yaml → machineDefault.
 *
 * When currentLoomDir is null the policy leg is skipped (no project to read from).
 * Never throws.
 */
export function resolveActiveLoomHome(
  currentLoomDir: string | null,
  machineDefault: string,
): string {
  // Priority 1: LOOM_HOME env var overrides everything
  const envHome = process.env.LOOM_HOME;
  if (envHome && envHome.length > 0) return envHome;

  // Priority 2: loom_home from the served project's policy.yaml
  if (currentLoomDir !== null) {
    try {
      const policyData = PolicyEngine.load(currentLoomDir, { env: {} }).policyData;
      const raw = policyData.loom_home;
      if (raw && raw.length > 0) {
        // Expand leading ~ so policy values like '~/my-loom' work correctly
        if (raw.startsWith('~/') || raw === '~') {
          return path.join(os.homedir(), raw.slice(1));
        }
        return raw;
      }
    } catch {
      // policy.yaml missing, malformed, or unreadable — fall through to default
    }
  }

  return machineDefault;
}

/**
 * Builds the unified registry from the active loom_home and the machine-default
 * loom_home. Machine-default entries are loaded first; active-loom_home entries
 * overlay (win on conflict). The currentProject is force-included even when absent
 * from both registry files, and a self-heal write is attempted to the active
 * registry (silently dropped on any fs error).
 */
export function buildUnifiedRegistry(
  activeLoomHome: string,
  machineDefaultLoomHome: string,
  currentProject: { projectRoot: string; loomDir: string } | null,
): { registry: Map<string, ProjectEntry>; selfHealOccurred: boolean } {
  const registry = new Map<string, ProjectEntry>();

  // Load machine-default entries first (lower priority)
  const machineRegistryPath = path.join(machineDefaultLoomHome, 'projects.json');
  for (const entry of readRegistryFile(machineRegistryPath)) {
    registry.set(entry.root, entry);
  }

  // Overlay with active-loom_home entries (higher priority — wins on conflict)
  const activeRegistryPath = path.join(activeLoomHome, 'projects.json');
  const activeEntries = readRegistryFile(activeRegistryPath);
  for (const entry of activeEntries) {
    registry.set(entry.root, entry);
  }

  // Force-include currentProject and self-heal if it was absent
  let selfHealOccurred = false;
  if (currentProject !== null && !registry.has(currentProject.projectRoot)) {
    const newEntry: ProjectEntry = {
      root: currentProject.projectRoot,
      registeredAt: new Date().toISOString(),
    };
    registry.set(currentProject.projectRoot, newEntry);

    // Attempt to persist the entry to the active registry (silent on any error)
    try {
      fs.mkdirSync(path.dirname(activeRegistryPath), { recursive: true });
      fs.writeFileSync(
        activeRegistryPath,
        JSON.stringify({ projects: [...activeEntries, newEntry] }, null, 2) + '\n',
      );
      selfHealOccurred = true;
    } catch {
      // A read-only registry must never crash the server
    }
  }

  return { registry, selfHealOccurred };
}

/**
 * Reads a projects.json registry file and returns its raw entries.
 * Returns [] when the file is absent or malformed — never throws.
 */
function readRegistryFile(registryPath: string): ProjectEntry[] {
  if (!fs.existsSync(registryPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as unknown;
    const list = (parsed as { projects?: unknown }).projects;
    if (!Array.isArray(list)) return [];
    return list
      .filter((e): e is ProjectEntry => !!e && typeof (e as ProjectEntry).root === 'string')
      .map(e => ({ root: (e as ProjectEntry).root, registeredAt: (e as ProjectEntry).registeredAt ?? '' }));
  } catch {
    return [];
  }
}
