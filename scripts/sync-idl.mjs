import { readFileSync, writeFileSync } from "node:fs";
const idl = JSON.parse(readFileSync("target/idl/trustpay.json", "utf8"));
writeFileSync("app/src/idl.json", JSON.stringify(idl, null, 2) + "\n");
console.log("IDL synchronized. Program:", idl.address);
