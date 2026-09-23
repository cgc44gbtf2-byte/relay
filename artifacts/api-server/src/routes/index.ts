import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import healthRouter from "./health";
import ircRouter from "./irc";
import adminRouter from "./admin";
import storageRouter from "./storage";
import communitiesRouter from "./communities";
import developerRouter from "./developer";
import testAccountsRouter from "./test-accounts";
import { requireAuth, getUserId, type AuthenticatedRequest } from "../lib/auth";
import { wsHub } from "../lib/ws";
import { FixedWindowLimiter, rateLimitKey } from "../lib/fixed-window-limiter";

const router: IRouter = Router();
const wsTicketLimiter = new FixedWindowLimiter(10, 60_000);

router.use(healthRouter);
router.use(ircRouter);
router.use(adminRouter);
router.use(storageRouter);
router.use(communitiesRouter);
router.use(developerRouter);
router.use(testAccountsRouter);
router.get("/ws-ticket", requireAuth, (req: AuthenticatedRequest, res) => {
  const sessionId = getAuth(req).sessionId;
  if (!sessionId) {
    res.status(401).json({ error: "Sign in to continue" });
    return;
  }
  const result = wsTicketLimiter.check(rateLimitKey(getUserId(req), req.ip ?? req.socket.remoteAddress ?? "unknown"));
  if (!result.allowed) {
    res.set("Retry-After", String(result.retryAfterSeconds)).status(429).json({ error: "Too many WebSocket ticket requests." });
    return;
  }
  res.json({ ticket: wsHub.issueTicket(getUserId(req), sessionId) });
});

export default router;