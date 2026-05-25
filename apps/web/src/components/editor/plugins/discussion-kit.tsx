'use client';

import type { TComment } from '@/components/ui/comment';

import type { AnyPluginConfig } from 'platejs';
import type { RenderNodeWrapper } from 'platejs/react';
import { createPlatePlugin } from 'platejs/react';

export type TDiscussion = {
  id: string;
  comments: TComment[];
  createdAt: Date;
  isResolved: boolean;
  userId: string;
  documentContent?: string;
};

export type DiscussionUser = {
  id: string;
  avatarUrl?: string;
  name: string;
  hue?: number;
};

export type DiscussionOptions = {
  currentUserId: string;
  discussions: TDiscussion[];
  users: Record<string, DiscussionUser>;
};

const DEFAULT_CURRENT_USER_ID = 'current';

const DEFAULT_DISCUSSION_OPTIONS: DiscussionOptions = {
  currentUserId: DEFAULT_CURRENT_USER_ID,
  discussions: [],
  users: {
    [DEFAULT_CURRENT_USER_ID]: {
      id: DEFAULT_CURRENT_USER_ID,
      name: 'LittleBun',
    },
  },
};

function mergeDiscussionOptions(
  options?: Partial<DiscussionOptions>
): DiscussionOptions {
  const users =
    options?.users && Object.keys(options.users).length > 0
      ? options.users
      : DEFAULT_DISCUSSION_OPTIONS.users;

  const userIds = Object.keys(users);
  const fallbackUserId = userIds[0] ?? DEFAULT_CURRENT_USER_ID;
  const currentUserId =
    options?.currentUserId && users[options.currentUserId]
      ? options.currentUserId
      : fallbackUserId;

  return {
    currentUserId,
    discussions: options?.discussions ?? DEFAULT_DISCUSSION_OPTIONS.discussions,
    users,
  };
}

// This plugin is purely UI. It's only used to store the discussions and users data
export const discussionPlugin = createPlatePlugin({
  key: 'discussion',
  options: DEFAULT_DISCUSSION_OPTIONS,
}).extendSelectors(({ getOption }) => ({
  currentUser: () => getOption('users')[getOption('currentUserId')],
  user: (id: string) => getOption('users')[id],
}));

export function createDiscussionKit(
  options?: Partial<DiscussionOptions>,
  renderOptions?: {
    aboveNodes?: RenderNodeWrapper<AnyPluginConfig>;
  }
) {
  const nextPlugin = discussionPlugin.configure({
    options: mergeDiscussionOptions(options),
    ...(renderOptions?.aboveNodes
      ? {
          render: {
            aboveNodes: renderOptions.aboveNodes,
          },
        }
      : {}),
  });

  return [nextPlugin] as const;
}

export const DiscussionKit = createDiscussionKit();
