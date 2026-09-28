import { z } from "zod";

export const PostSettingsSchema = z.object({
  commentsEnabled: z.boolean().default(true),
  reactionsEnabled: z.boolean().default(true),
  showDislike: z.boolean().default(true),
  showViews: z.boolean().default(true),
  showToc: z.boolean().default(true),
  telegraphMirror: z.boolean().default(true),
  channelAutoPost: z.boolean().default(true),
  allowAnonymousComments: z.boolean().default(true),
  commentsRequireApproval: z.boolean().default(false),
});

export type PostSettings = z.infer<typeof PostSettingsSchema>;

export const DEFAULT_POST_SETTINGS: PostSettings = {
  commentsEnabled: true,
  reactionsEnabled: true,
  showDislike: true,
  showViews: true,
  showToc: true,
  telegraphMirror: true,
  channelAutoPost: true,
  allowAnonymousComments: true,
  commentsRequireApproval: false,
};
