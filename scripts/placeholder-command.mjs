const [workspace = "app-template", command = "command", detail = "Implementation is pending"] =
  process.argv.slice(2);

console.log(`${workspace}: ${command} is a placeholder. ${detail}.`);
