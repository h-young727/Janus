import asyncio
import json
import sys
from collections import deque
import websockets

class BackendLink:
    def __init__(self, url: str, on_command, max_buffer: int = 1000):
        self.url = url
        self.on_command = on_command
        self.outbox = deque(maxlen=max_buffer)
        self.ready = asyncio.Event()

    def send(self, msg: dict):
        self.outbox.append(json.dumps(msg))
        self.ready.set()

    async def run(self):
        delay = 1
        while True:
            try:
                async with websockets.connect(self.url) as ws:
                    print(f"backend connected: {self.url}")
                    delay = 1
                    tasks = [asyncio.create_task(self.send_loop(ws)), asyncio.create_task(self.receive_loop(ws))]
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in pending:
                        task.cancel()
                    for task in done:
                        task.result()
                print("backend disconnected")
            except (OSError, websockets.WebSocketException) as exc:
                print(f"backend unavailable ({exc}), retrying in {delay}s, {len(self.outbox)} messages buffered")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)

    async def send_loop(self, ws):
        while True:
            self.ready.clear()
            while self.outbox:
                await ws.send(self.outbox[0])
                self.outbox.popleft()
            await self.ready.wait()

    async def receive_loop(self, ws):
        async for text in ws:
            self.on_command(text)

if __name__ == "__main__":
    async def main():
        link = BackendLink(sys.argv[1], lambda text: print("received:", text))
        async def heartbeat():
            count = 0
            while True:
                link.send({"type": "test", "count": count})
                count += 1
                await asyncio.sleep(1)
        await asyncio.gather(link.run(), heartbeat())
    asyncio.run(main())
