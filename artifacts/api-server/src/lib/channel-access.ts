import { and, eq } from "drizzle-orm";
import {
  channelMembersTable,
  channelsTable,
  communitiesTable,
  communityMembersTable,
  db,
} from "@workspace/db";
import { hasPermission } from "./permissions";

export type ReadableChannel = {
  id: number;
  isPrivate: boolean;
  communityId?: number | null;
};

export async function canReadChannel(
  channel: ReadableChannel,
  userId: string,
): Promise<boolean> {
  const communityId = channel.communityId ?? null;
  if (communityId !== null) {
    const [community] = await db
      .select({ isPrivate: communitiesTable.isPrivate })
      .from(communitiesTable)
      .where(eq(communitiesTable.id, communityId))
      .limit(1);
    const [member] = await db
      .select({ userId: communityMembersTable.userId })
      .from(communityMembersTable)
      .where(
        and(
          eq(communityMembersTable.communityId, communityId),
          eq(communityMembersTable.userId, userId),
        ),
      )
      .limit(1);
    if (
      community?.isPrivate !== false &&
      !member &&
      !(await hasPermission(userId, "view_business", { communityId })) &&
      !(await hasPermission(userId, "manage_community", { communityId }))
    ) {
      return false;
    }
  }

  if (!channel.isPrivate) return true;
  const [member] = await db
    .select({ userId: channelMembersTable.userId })
    .from(channelMembersTable)
    .where(
      and(
        eq(channelMembersTable.channelId, channel.id),
        eq(channelMembersTable.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(member);
}

export async function channelForRead(
  channelId: number,
): Promise<ReadableChannel | null> {
  const [channel] = await db
    .select({
      id: channelsTable.id,
      isPrivate: channelsTable.isPrivate,
      communityId: channelsTable.communityId,
    })
    .from(channelsTable)
    .where(eq(channelsTable.id, channelId))
    .limit(1);
  return channel ?? null;
}