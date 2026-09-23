export const MEMBER_REMOVAL_CONFIRMATION = "REMOVE MEMBER {target} FROM WORKSPACE {workspace}";
export const ACCOUNT_DELETION_CONFIRMATION = "DELETE ACCOUNT {target} FROM WORKSPACE {workspace}";
export const COMMUNITY_DELETION_CONFIRMATION = "DELETE WORKSPACE {workspace}";
export const memberRemovalConfirmation = (target: string, workspace: string) =>
  `REMOVE MEMBER ${target} FROM WORKSPACE ${workspace}`;
export const accountDeletionConfirmation = (target: string, workspace: string) =>
  `DELETE ACCOUNT ${target} FROM WORKSPACE ${workspace}`;
export const communityDeletionConfirmation = (workspace: string) =>
  `DELETE WORKSPACE ${workspace}`;

export function exactCommunityOwner(ownerId: string, authenticatedUserId: string): boolean {
  return ownerId === authenticatedUserId;
}

export function confirmationMatches(template: string, value: unknown, target: string, workspace: string): boolean {
  return typeof value === "string"
    && value === template.replace("{target}", target).replace("{workspace}", workspace);
}

export function targetMayBePermanentlyDeleted(
  targetCommunityIds: readonly number[],
  targetOwnedCommunityIds: readonly number[],
  requesterOwnedCommunityIds: readonly number[],
): boolean {
  return targetOwnedCommunityIds.length === 0
    && targetCommunityIds.every((id) => requesterOwnedCommunityIds.includes(id));
}