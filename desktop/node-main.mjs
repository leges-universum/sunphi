// Separate executable/application identity, same reviewed wallet engine.
process.argv.push('--sunphi-node');
await import('./main.mjs');
