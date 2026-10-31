from typing import Optional
from pydantic import BaseModel, Field

class MotionJobRequest(BaseModel):
image_url: str = Field(..., min_length=1)
prompt: str = Field(..., min_length=1)
duration_seconds: int = Field(default=5, ge=1, le=10)
aspect_ratio: str = "16:9"

class MotionJobResponse(BaseModel):
job_id: str
status: str
message: str
video_url: Optional[str] = None
