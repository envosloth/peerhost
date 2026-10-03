// Process-protocol fixture only: this is NOT Java or a Minecraft server.
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const value = (name, fallback) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const lifetime = setTimeout(() => process.exit(Number(value('--exit-code', '0'))), Number(value('--lifetime-ms', '5000')));
console.log(`fixture ${JSON.stringify({ args, cwd: process.cwd(), pid: process.pid })}`);
console.error('fixture stderr diagnostic');
setTimeout(() => {
  if (args.includes('--stderr-ready')) console.error('Done (fixture)!');
  else if (!args.includes('--no-ready')) console.log('Done (fixture)!');
}, 20);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (command) => {
  console.log(`console:${command}`);
  if (args.includes('--exit-on-command')) process.exit(7);
  if (command === 'stop' && !args.includes('--ignore-stop')) {
    console.log('fixture stopping');
    input.close();
    clearTimeout(lifetime);
    setTimeout(() => {
      console.log('fixture stopped');
      process.exit(0);
    }, Number(value('--stop-delay-ms', '0')));
  }
});
