export const routes = {
  repos: () => '/' as const,
  epics: (slug: string) => `/repo/${slug}` as const,
  stories: (slug: string, epicId: string) => `/repo/${slug}/epic/${epicId}` as const,
  story: (slug: string, epicId: string, storyId: string) =>
    `/repo/${slug}/epic/${epicId}/story/${storyId}` as const,
};
