
from pydantic import BaseModel, Field


class MotionJobRequest(BaseModel):
    image_url: str = Field(
        min_length=1,
        description="URL de l'image source"
    )

    prompt: str = Field(
        min_length=3,
        max_length=2000
    )

    duration_seconds: int = Field(
        default=5,
        ge=1,
        le=10
    )

    aspect_ratio: str = Field(
        default="16:9",
        pattern=r"^(16:9|9:16|1:1)$"
    )


class MotionJobResponse(BaseModel):
    status: str
    message: str
