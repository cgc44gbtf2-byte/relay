import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  authorizationRoleRank,
  canGrantWorkspaceRole,
} from "./role-grant-policy";

describe("workspace role grant policy", () => {
  test("uses one ordered hierarchy for built-in authorization roles", () => {
    const roleLevels = [
      ["member", "employee", "contractor"],
      ["moderator"],
      ["manager", "business_manager"],
      ["department_admin", "community_admin"],
      ["workspace_admin"],
      ["workspace_owner", "business_owner"],
      ["platform_moderator"],
      ["admin"],
    ];
    for (const roles of roleLevels) {
      const ranks = new Set(roles.map((role) => authorizationRoleRank(role)));
      assert.equal(ranks.size, 1, `${roles.join(", ")} must share one rank`);
    }
    for (let index = 1; index < roleLevels.length; index += 1) {
      assert.ok(
        authorizationRoleRank(roleLevels[index][0])
          > authorizationRoleRank(roleLevels[index - 1][0]),
        `${roleLevels[index].join(", ")} must outrank ${roleLevels[index - 1].join(", ")}`,
      );
    }
    assert.equal(authorizationRoleRank("unknown_custom_role"), 0);
  });

  test("never lets a workspace role grant an equal or higher role", () => {
    const levels = [
      ["member", "employee", "contractor"],
      ["moderator"],
      ["manager", "business_manager"],
      ["department_admin", "community_admin"],
      ["workspace_admin"],
      ["workspace_owner", "business_owner"],
      ["platform_moderator"],
      ["admin"],
    ];
    for (const [actorLevel, actorRoles] of levels.entries()) {
      for (const actorRole of actorRoles) {
        for (const [targetLevel, targetRoles] of levels.entries()) {
          for (const targetRole of targetRoles) {
            assert.equal(
              canGrantWorkspaceRole([actorRole], targetRole),
              actorLevel > targetLevel && targetLevel < 6,
              `${actorRole} -> ${targetRole}`,
            );
          }
        }
      }
    }
    assert.equal(canGrantWorkspaceRole(["manager"], "moderator"), true);
    assert.equal(canGrantWorkspaceRole(["manager"], "member"), true);
    assert.equal(canGrantWorkspaceRole(["manager"], "department_admin"), false);
    assert.equal(canGrantWorkspaceRole(["workspace_admin"], "workspace_owner"), false);
  });

  test("does not treat an unknown or custom permission role as ranked authority", () => {
    assert.equal(canGrantWorkspaceRole(["custom_people_manager"], "moderator"), false);
    assert.equal(
      canGrantWorkspaceRole(["custom_people_manager", "manager"], "moderator"),
      true,
    );
    assert.equal(canGrantWorkspaceRole(["workspace_owner"], "custom_role"), false);
    assert.equal(canGrantWorkspaceRole([], "member"), false);
  });
});