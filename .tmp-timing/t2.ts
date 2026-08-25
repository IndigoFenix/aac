import 'dotenv/config';
const t0 = Date.now();
await import("../server/routes");
console.log("routes import ms", Date.now() - t0);
setTimeout(() => process.exit(0), 3000);
