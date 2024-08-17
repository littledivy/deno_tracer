const encoder = new TextEncoder()
const output = new Uint8Array(1024)
while(true) encoder.encodeInto("Hello, world!", output)
