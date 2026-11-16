import {toNamespacedPath} from 'node:path';
// Node filesystem calls accept long Windows paths, but SQLite needs the
// explicit extended-length form. Keep public/display paths unchanged.
export const sqlitePath=file=>process.platform==='win32'&&typeof file==='string'&&file!==':memory:'?toNamespacedPath(file):file;
