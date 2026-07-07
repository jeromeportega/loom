export const queryKeys = {
  repos: () => ['repos'] as const,
  epics: (slug: string) => ['repos', slug, 'epics'] as const,
  stories: (slug: string, epicId: string) => ['repos', slug, epicId, 'stories'] as const,
  story: (slug: string, epicId: string, storyId: string) =>
    ['repos', slug, epicId, 'stories', storyId] as const,
  planningArtifacts: (slug: string, epicId: string) =>
    ['repos', slug, epicId, 'planning-artifacts'] as const,
};
