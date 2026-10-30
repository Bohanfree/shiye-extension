export const HISTORY_DAYS=7;
export const HISTORY_WINDOW_MS=HISTORY_DAYS*24*60*60*1000;
export const historyCutoff=(at=Date.now())=>at-HISTORY_WINDOW_MS;
