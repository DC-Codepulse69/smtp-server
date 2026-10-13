import "./envLoad.js";

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
// import { authenticate } from "mailauth";

const SMTP_PORT = Number(process.env.SMTP_PORT || 25);
const MAX_MESSAGE_SIZE = 25 * 1024 * 1024; // 25 MB
const EMAIL_DIR = path.resolve("./emails");
const PROCESSED_EMAILS_FILE = path.join(
    EMAIL_DIR,
    ".processed-email-requests"
);
const processedEmailKeys = new Set();
let processedEmailKeysLoaded = false;

import axios from "axios";

function getEmailKey(rawEmail, messageId) {
    const identity = messageId
        ? `message-id:${messageId}`
        : `raw-email:${crypto
            .createHash("sha256")
            .update(rawEmail)
            .digest("hex")}`;

    return crypto
        .createHash("sha256")
        .update(identity)
        .digest("hex");
}

async function claimEmail(rawEmail, messageId) {
    if (!processedEmailKeysLoaded) {
        try {
            const entries = await fs.readFile(
                PROCESSED_EMAILS_FILE,
                "utf8"
            );

            for (const entry of entries.split("\n")) {
                if (entry) {
                    processedEmailKeys.add(entry);
                }
            }
        } catch (err) {
            if (err.code !== "ENOENT") {
                throw err;
            }
        }

        processedEmailKeysLoaded = true;
    }

    const emailKey = getEmailKey(rawEmail, messageId);

    if (processedEmailKeys.has(emailKey)) {
        return false;
    }

    // Claim before making the API request. This intentionally prevents an
    // SMTP retry after an API error from sending the request a second time.
    processedEmailKeys.add(emailKey);

    try {
        await fs.mkdir(EMAIL_DIR, {
            recursive: true
        });

        await fs.appendFile(
            PROCESSED_EMAILS_FILE,
            `${emailKey}\n`,
            "utf8"
        );
    } catch (err) {
        processedEmailKeys.delete(emailKey);
        throw err;
    }

    return true;
}

// const VALID_RECIPIENTS = new Set([
//     "admin@example.com",
//     "support@example.com"
// ]);

const smtpServer = new SMTPServer({
    authOptional: true,
    allowInsecureAuth: false,

    disabledCommands: ["AUTH"],

    size: MAX_MESSAGE_SIZE,

    onConnect(session, callback) {
        console.log(
            `[CONNECT] ${session.remoteAddress}`
        );

        callback();
    },

    onMailFrom(address, session, callback) {
        console.log(
            `[MAIL FROM] ${address.address}`
        );

        if (!address.address?.includes("@")) {
            return callback(
                new Error("550 Invalid sender")
            );
        }

        callback();
    },

    onRcptTo(address, session, callback) {
        const recipient = address.address.toLowerCase();

        console.log(
            `[RCPT TO] ${recipient}`
        );

        // if (!VALID_RECIPIENTS.has(recipient)) {
        //     return callback(
        //         new Error("550 User does not exist")
        //     );
        // }

        callback();
    },

    async onData(stream, session, callback) {
        let callbackCalled = false;
        const complete = err => {
            if (callbackCalled) {
                return;
            }

            callbackCalled = true;
            callback(err);
        };

        try {
            const chunks = [];

            stream.on("data", chunk => {
                chunks.push(chunk);
            });

            stream.on("error", complete);

            stream.on("end", async () => {
                if (callbackCalled) {
                    return;
                }

                try {
                    const rawEmail = Buffer.concat(chunks);

                    // Store raw message
                    const fileName =
                        `${Date.now()}-${Math.random()
                            .toString(36)
                            .slice(2)}.eml`;

                    await fs.mkdir(EMAIL_DIR, {
                        recursive: true
                    });

                    await fs.writeFile(
                        path.join(EMAIL_DIR, fileName),
                        rawEmail
                    );

                    // SPF / DKIM / DMARC
                    // const authResult =
                    //     await authenticate(rawEmail);

                    // Parse message
                    const mail =
                        await simpleParser(rawEmail);

                    const parsedMail = {
                        messageId: mail.messageId,
                        date: mail.date,

                        from: mail.from?.value || [],
                        to: mail.to?.value || [],
                        cc: mail.cc?.value || [],
                        bcc: mail.bcc?.value || [],

                        subject: mail.subject,

                        text: mail.text,
                        html: mail.html,

                        attachments:
                            mail.attachments.map(a => ({
                                filename: a.filename,
                                size: a.size,
                                contentType: a.contentType
                            })),

                        // authentication: {
                        //     spf:
                        //         authResult.spf?.status
                        //             ?.result,
                        //     dkim:
                        //         authResult.dkim?.results,
                        //     dmarc:
                        //         authResult.dmarc?.status
                        //             ?.result
                        // }
                    };

                    console.log(
                        JSON.stringify(
                            parsedMail,
                            null,
                            2
                        )
                    );

                    const claimed = await claimEmail(
                        rawEmail,
                        mail.messageId
                    );

                    if (!claimed) {
                        console.log(
                            `[DUPLICATE EMAIL] Skipping API request for ${
                                mail.messageId || "message without Message-ID"
                            }`
                        );
                        return complete();
                    }

                    await axios.post(
                        `${process.env.API_URL || "http://localhost:3000"}/api/new-email`,
                        parsedMail
                    );

                    // Save to DB here

                    complete();
                } catch (err) {
                    console.error(
                        "[PROCESS EMAIL ERROR]",
                        err
                    );

                    complete(err);
                }
            });
        } catch (err) {
            complete(err);
        }
    }
});

smtpServer.listen(SMTP_PORT, () => {
    console.log(
        `SMTP server listening on port ${SMTP_PORT}`
    );
});

smtpServer.on("error", err => {
    console.error(
        "[SMTP SERVER ERROR]",
        err
    );
});

process.on("uncaughtException", err => {
    console.error(
        "[UNCAUGHT EXCEPTION]",
        err
    );
});

process.on("unhandledRejection", err => {
    console.error(
        "[UNHANDLED REJECTION]",
        err
    );
});