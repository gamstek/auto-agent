const values = process.argv.slice(2).map(Number);
if (!values.length || values.some((value) => !Number.isFinite(value))) {
  console.error('Supply one or more finite numbers');
  process.exitCode = 1;
} else {
  console.log(values.reduce((sum, value) => sum + value, 0));
}
