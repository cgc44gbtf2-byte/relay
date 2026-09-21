import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ircRouter from "./irc";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ircRouter);

export default router;
