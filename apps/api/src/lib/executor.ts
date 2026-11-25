import type { db } from "../db/index.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** `db` yoki tranzaksiya (`tx`) — ikkalasida ham so'rov yozish mumkin. */
export type Executor = typeof db | Tx;
