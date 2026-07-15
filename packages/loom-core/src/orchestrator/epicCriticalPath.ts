import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { EpicYamlSchema, type Story } from '../types.js';

/**
 * Reads an epic's YAML file and returns its stories, or null when the file is
 * absent or unparseable. Callers use the returned Story[] with buildStoryGraph
 * and criticalPath from storyGraph.ts to compute the critical path.
 */
export function loadEpicStories(projectRoot: string, yamlPath: string): Story[] | null {
  const filePath = path.join(projectRoot, yamlPath);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = EpicYamlSchema.parse(yaml.load(fs.readFileSync(filePath, 'utf8')));
    return parsed.stories;
  } catch {
    return null;
  }
}
