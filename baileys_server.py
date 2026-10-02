#!/usr/bin/env python3
"""
Baileys HTTP Bridge — async Python wrapper for the bot.js Node server.

The BaileysServer class exposes exactly three public methods:

    send()          Send a text message and/or one or more files
    get_messages()  Fetch queued incoming messages
    status()        Check bot connection status

Everything else is private. Use the class as an async context manager so the
HTTP session is opened and closed for you:

Usage as library:
    from baileys_server import BaileysServer

    async with BaileysServer() as bot:
        # Text message
        await bot.send("+852****8251", "Hello")

        # One file (caption applies to it)
        await bot.send("+852****8251", files="/path/to/report.pdf",
                       media_type="document", caption="Monthly report")

        # Multiple files, per-file captions (paired in order)
        await bot.send("+852****8251",
                       files=["/path/a.pdf", "/path/b.jpg"],
                       media_type="image",
                       caption=["Caption A", "Caption B"])

        # Text + files in one call (text first, then files)
        await bot.send("+852****8251", "Here are the reports",
                       files=["/path/a.pdf", "/path/b.pdf"])

        msgs = await bot.get_messages()

Usage as test script:
    python3 baileys_server.py
    python3 baileys_server.py --send "+852****8251" "Test message"
    python3 baileys_server.py --send-files "+852****8251" /path/a.pdf /path/b.jpg
    python3 baileys_server.py --send-files "+852****8251" /path/a.jpg /path/b.jpg \
        --media-type image --caption "Cap A" --caption "Cap B"
    python3 baileys_server.py --poll 30
"""

import asyncio
import os
import re
import json
import time
import argparse
import mimetypes
import aiohttp


class BaileysServer:
    """Async wrapper for the bot.js HTTP server (default: localhost:3100).

    Exactly three public methods: ``send``, ``get_messages``, ``status``.
    Use as an async context manager (``async with BaileysServer() as bot``)
    for automatic session cleanup.
    """

    BASE_URL = "http://localhost:3100"

    def __init__(self, base_url=None):
        self.base_url = (base_url or self.BASE_URL).rstrip("/")
        self._last_since = 0
        self._session = None

    # ── Lifecycle ──────────────────────────────────────────────

    async def __aenter__(self):
        await self._get_session()
        return self

    async def __aexit__(self, exc_type, exc, tb):
        await self._close()

    def __del__(self):
        # Best-effort cleanup if the user forgot to close / use `async with`.
        if hasattr(self, "_session") and self._session and not self._session.closed:
            try:
                asyncio.get_running_loop().create_task(self._close())
            except RuntimeError:
                pass

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def _close(self):
        if self._session and not self._session.closed:
            await self._session.close()

    # ── Public: connection ─────────────────────────────────────

    async def status(self) -> dict:
        """Check bot connection status. Returns the raw /status JSON dict."""
        session = await self._get_session()
        async with session.get(
            f"{self.base_url}/status",
            timeout=aiohttp.ClientTimeout(total=5),
        ) as resp:
            return await resp.json()

    # ── Public: send ───────────────────────────────────────────

    async def send(
        self,
        phone: str,
        message: str = None,
        files: "str | list" = None,
        media_type: str = "document",
        caption: "str | list" = "",
        file_name: str = None,
        mimetype: str = None,
        ptt: bool = False,
    ) -> list:
        """Unified send — text message and/or one or more files, in one call.

        Note: bot.js ENQUEUES every item (anti-ban pacing). This call returns
        immediately with HTTP 202 per item; the bot sends them one by one with
        a random 1-3 minute gap between sends. Check GET /queue on bot.js to
        watch progress.

        Args:
            phone: Phone number in any format (+852 5275 8251, 85252758251, ...).
            message: Optional text message. If both text and files are given,
                     the text is sent first, then the files.
            files: Path to one file, or a list of file paths. Each file is
                   uploaded over HTTP (multipart) and delivered as its own
                   media message to the recipient.
            media_type: 'document' (default), 'image', 'video', or 'audio'.
            caption: Caption shown on the file(s) in WhatsApp. A single
                     string applies to every file; a list is paired with the
                     file list (files without a matching entry get no caption).
            file_name: Override filename shown in WhatsApp. Single-file only;
                       multi-file sends use each file's own name.
            mimetype: Override MIME type. Single-file only; multi-file sends
                      guess from each file's extension.
            ptt: If True, send audio as a voice note.

        Returns:
            List of response dicts from bot.js — one per item ENQUEUED, in
            order (text first, then files). Each contains the queue id and
            position (202 responses), not delivery confirmation.

        Raises:
            ValueError: if neither message nor files is provided.
        """
        clean_phone = re.sub(r"[^0-9]", "", phone)
        results = []

        if message:
            session = await self._get_session()
            async with session.post(
                f"{self.base_url}/send",
                json={"phone": clean_phone, "message": message},
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                results.append(await resp.json())

        if files is not None:
            if isinstance(files, (str, os.PathLike)):
                files = [files]
            file_list = list(files)
            if isinstance(caption, (list, tuple)):
                captions = list(caption)
            else:
                captions = [caption] * len(file_list)

            for i, file_path in enumerate(file_list):
                results.append(await self._send_one_file(
                    clean_phone,
                    file_path,
                    media_type=media_type,
                    caption=captions[i] if i < len(captions) else "",
                    file_name=file_name if len(file_list) == 1 else None,
                    mimetype=mimetype if len(file_list) == 1 else None,
                    ptt=ptt,
                ))

        if not results:
            raise ValueError("Nothing to send — provide 'message' and/or 'files'")
        return results

    async def _send_one_file(
        self,
        clean_phone: str,
        file_path: str,
        media_type: str = "document",
        caption: str = "",
        file_name: str = None,
        mimetype: str = None,
        ptt: bool = False,
    ) -> dict:
        """Upload one file to bot.js as multipart/form-data and send it."""
        with open(file_path, "rb") as f:
            data = f.read()

        if mimetype is None:
            mimetype = mimetypes.guess_type(str(file_path))[0]
        if file_name is None:
            file_name = os.path.basename(str(file_path))

        session = await self._get_session()
        form = aiohttp.FormData()
        form.add_field("phone", clean_phone)
        form.add_field("mediaType", media_type)
        if caption:
            form.add_field("caption", caption)
        form.add_field(
            "file",
            data,
            filename=file_name,
            content_type=mimetype or "application/octet-stream",
        )
        if mimetype:
            form.add_field("mimetype", mimetype)
        if ptt:
            form.add_field("ptt", "true")

        async with session.post(
            f"{self.base_url}/send",
            data=form,
            timeout=aiohttp.ClientTimeout(total=120),
        ) as resp:
            return await resp.json()

    # ── Public: receive ────────────────────────────────────────

    async def get_messages(self, since: float = None) -> list:
        """Fetch queued incoming messages.

        Advances the internal cursor automatically so repeated calls only
        return new messages.

        Args:
            since: Unix timestamp in seconds. Defaults to the internal cursor.

        Returns:
            List of message dicts.
        """
        ts = self._last_since if since is None else since
        data = await self._get_messages_raw(ts)
        messages = data.get("messages", [])
        if messages:
            self._last_since = time.time()
        return messages

    async def _get_messages_raw(self, since: float = 0) -> dict:
        """Fetch the full /messages response (does not advance the cursor).

        ``since`` is a Unix timestamp in seconds; the raw endpoint expects
        milliseconds, so it is converted here.
        """
        ts = int((since or 0) * 1000)
        session = await self._get_session()
        async with session.get(
            f"{self.base_url}/messages",
            params={"since": ts},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            return await resp.json()


# ── CLI test script ─────────────────────────────────────────────

async def cli_status(bot: BaileysServer):
    """Print bot status. Returns the /status dict, or None if unreachable."""
    print("\n── Status ──")
    try:
        data = await bot.status()
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return data
    except (aiohttp.ClientError, asyncio.TimeoutError):
        print("❌ Cannot connect to bot.js — is it running on port 3100?")
        return None


def _fail(prefix: str, exc: Exception):
    """Print a failure, naming timeouts explicitly (their str() is empty)."""
    detail = str(exc) or ("request timed out" if isinstance(exc, asyncio.TimeoutError) else "unknown error")
    print(f"❌ {prefix}: {detail}")


async def cli_send(bot: BaileysServer, phone: str, message: str):
    print(f"\n── Send to {phone} ──")
    try:
        for r in await bot.send(phone, message):
            print(f"[send] {json.dumps(r, ensure_ascii=False)}")
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as e:
        _fail("Send failed", e)


async def cli_send_files(bot: BaileysServer, phone: str, file_paths: list,
                         media_type: str, captions: list, ptt: bool):
    print(f"\n── Send file(s) to {phone} ──")
    missing = [p for p in file_paths if not os.path.isfile(p)]
    if missing:
        print(f"❌ File(s) not found: {', '.join(missing)}")
        return
    # 0 or 1 caption → string (applies to all); multiple → paired per file
    caption = captions if len(captions) > 1 else (captions[0] if captions else "")
    print(f"   files: {', '.join(file_paths)}")
    try:
        results = await bot.send(
            phone,
            files=file_paths,
            media_type=media_type,
            caption=caption,
            ptt=ptt,
        )
        for i, r in enumerate(results, 1):
            print(f"[{i}/{len(results)}] {json.dumps(r, ensure_ascii=False)}")
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError) as e:
        _fail("Send file failed", e)


async def cli_receive(bot: BaileysServer):
    print("\n── Receive ──")
    try:
        print(json.dumps(await bot._get_messages_raw(since=0),
                         indent=2, ensure_ascii=False))
    except (aiohttp.ClientError, asyncio.TimeoutError):
        print("❌ Cannot connect to bot.js")


async def cli_poll(bot: BaileysServer, interval: int):
    """Poll for new incoming messages every ``interval`` seconds (Ctrl+C stops)."""
    print(f"\n── Polling every {interval}s (Ctrl+C to stop) ──")
    while True:
        for msg in await bot.get_messages():
            print(json.dumps(msg, ensure_ascii=False))
        await asyncio.sleep(interval)


async def main_async(args):
    async with BaileysServer() as bot:
        if (await cli_status(bot)) is None:
            return

        if args.send:
            await cli_send(bot, args.send[0], args.send[1])

        if args.send_files:
            await cli_send_files(
                bot, args.send_files[0], args.send_files[1:],
                media_type=args.media_type,
                captions=args.caption,
                ptt=args.ptt,
            )

        if args.poll:
            await cli_poll(bot, args.poll)
        elif args.all or (not args.send and not args.send_files):
            await cli_receive(bot)


def main():
    parser = argparse.ArgumentParser(description="Test the bot.js server (async)")
    parser.add_argument("--send", nargs=2, metavar=("PHONE", "MESSAGE"),
                        help="Send a test message")
    parser.add_argument("--send-files", nargs="+", metavar=("PHONE", "FILE..."),
                        help="Send one or more files (first arg = phone, "
                             "remaining args = file paths; uploaded over HTTP)")
    parser.add_argument("--media-type", default="document",
                        choices=["document", "image", "video", "audio"],
                        help="Media type for --send-files (default: document)")
    parser.add_argument("--caption", action="append", default=[], metavar="TEXT",
                        help="Caption for --send-files. Repeatable: first caption "
                             "applies to all files, extra captions pair with "
                             "files in order")
    parser.add_argument("--ptt", action="store_true",
                        help="Send --send-files audio as voice notes")
    parser.add_argument("--poll", type=int, default=None, metavar="SECONDS",
                        help="Poll for new incoming messages every SECONDS "
                             "(Ctrl+C to stop)")
    parser.add_argument("--all", action="store_true",
                        help="Also run the one-shot receive test")
    args = parser.parse_args()

    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
