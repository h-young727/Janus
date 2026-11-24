
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.auth import (
    create_access_token,
    get_current_username,
)
from backend.users import (
    authenticate_user,
    create_user,
    get_user,
    initialize_users,
    list_usernames,
)

router = APIRouter(prefix="/api", tags=["Authentication"])

initialize_users()


class LoginRequest(BaseModel):
    username: str
    password: str


class CreateUserRequest(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=8)
    is_admin: bool = False


@router.post("/auth/login")
def login(request: LoginRequest):
    user = authenticate_user(
        request.username,
        request.password,
    )

    if user is None:
        raise HTTPException(
            status_code=401,
            detail="Invalid username or password",
        )

    token = create_access_token(user["username"])

    return {
        "access_token": token,
        "token_type": "bearer",
    }


@router.get("/auth/me")
def current_user(
    username: str = Depends(get_current_username),
):
    user = get_user(username)

    if user is None:
        raise HTTPException(status_code=401, detail="User not found")

    return {
        "id": user["id"],
        "username": user["username"],
        "is_admin": bool(user["is_admin"]),
    }


@router.get("/users")
def list_users(username: str = Depends(get_current_username)):
    current = get_user(username)
    if current is None:
        raise HTTPException(status_code=401, detail="User not found")
    if not current["is_admin"]:
        raise HTTPException(status_code=403, detail="Administrator permission required")
    return {"users": list_usernames()}


@router.post("/users", status_code=201)
def register_user(
    request: CreateUserRequest,
    username: str = Depends(get_current_username),
):
    current = get_user(username)

    if current is None:
        raise HTTPException(status_code=401, detail="User not found")

    if not current["is_admin"]:
        raise HTTPException(
            status_code=403,
            detail="Administrator permission required",
        )

    try:
        return create_user(
            request.username,
            request.password,
            request.is_admin,
        )
    except sqlite3.IntegrityError:
        raise HTTPException(
            status_code=409,
            detail="Username already exists",
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
