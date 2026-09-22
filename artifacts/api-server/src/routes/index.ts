import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import healthRouter from "./health";
import ircRouter from "./irc";
import adminRouter from "./admin";
import storageRouter from "./storage";
import communitiesRouter from "./communities";
import developerRouter from "./developer";
import { requireAuth, getUserId, type AuthenticatedRequest } from "../lib/auth";
import { wsHub } from "../lib/ws";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ircRouter);
router.use(adminRouter);
router.use(storageRouter);
router.use(communitiesRouter);
router.use(developerRouter);
router.get("/ws-ticket", requireAuth, (req: AuthenticatedRequest, res) => {
  const sessionId = getAuth(req).sessionId;
  if (!sessionId) {
    res.status(401).json({ error: "Sign in to continue" });
    return;
  }
  res.json({ ticket: wsHub.issueTicket(getUserId(req), sessionId) });
});

export default router;