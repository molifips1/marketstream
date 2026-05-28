from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()

# Database mock
def save_bet(streamer_id, data):
    # This is where you insert the data into your DB (e.g., MongoDB/PostgreSQL)
    print(f"💰 Received from {streamer_id}: {data}")

@app.post("/streamer-data")
async def collect(data: dict, x_streamer_key: str = Header(None)):
    if not x_streamer_key:
        raise HTTPException(status_code=403, detail="Key missing")
    save_bet(x_streamer_key, data)
    return {"status": "ok"}