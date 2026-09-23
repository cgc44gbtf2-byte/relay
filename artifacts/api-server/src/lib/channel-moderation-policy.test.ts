import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canPromoteChannelModerator } from "./channel-moderation-policy";

describe("channel moderator promotion policy", () => {
  test("allows owners and scoped channel managers to promote members", () => {
    assert.equal(canPromoteChannelModerator({
      actorRole: "owner",
      actorCanManageChannel: false,
      targetRole: "member",
    }), true);
    assert.equal(canPromoteChannelModerator({
      actorRole: null,
      actorCanManageChannel: true,
      targetRole: "member",
    }), true);
  });

  test("prevents moderators and members from granting moderator status", () => {
    for (const actorRole of ["moderator", "member", null] as const) {
      assert.equal(canPromoteChannelModerator({
        actorRole,
        actorCanManageChannel: false,
        targetRole: "member",
      }), false);
    }
  });

  test("only promotes current members with the lower channel role", () => {
    for (const targetRole of ["moderator", "owner", null] as const) {
      assert.equal(canPromoteChannelModerator({
        actorRole: "owner",
        actorCanManageChannel: false,
        targetRole,
      }), false);
    }
  });
});