type ModeratorPromotionPolicy = {
  actorRole: string | null;
  actorCanManageChannel: boolean;
  targetRole: string | null;
};

export function canPromoteChannelModerator({
  actorRole,
  actorCanManageChannel,
  targetRole,
}: ModeratorPromotionPolicy): boolean {
  const actorCanPromote = actorRole === "owner" || actorCanManageChannel;
  return actorCanPromote && targetRole === "member";
}