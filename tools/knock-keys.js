#!/usr/bin/env node
/*
  Makes the key pair knocks are signed with, and prints it as the two lines
  to add to the server's environment — on the Pi, /etc/direct-connection.env
  (see deploy/pi/SETUP.md):

      node tools/knock-keys.js

  Once is enough. A new pair later is not a disaster but not free either:
  every device that turned alerts on subscribed for the old one, and has to
  subscribe again (the page does it by itself next time it is opened), and
  then tell each saved person again (it does that next time they connect).
  The private key is the server's alone: never in the repository, a page or
  a message. See knock.js.
*/

"use strict";

const { makeKnockKeys } = require("../knock.js");

const keys = makeKnockKeys();
console.log(`KNOCK_PUBLIC_KEY=${keys.publicKey}`);
console.log(`KNOCK_PRIVATE_KEY=${keys.privateKey}`);
