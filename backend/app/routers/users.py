"""
User profiles + roles. Firebase Auth handles identity (who you are);
Firestore's `users` collection is the separate source of truth for role
("user" | "admin") the rest of the API trusts. The client never gets to set
its own role — `bootstrap` always writes role="user" the first time it sees
a uid, and never touches role again after that. Promotion to "admin" is a
manual, out-of-band operation (Firestore console / admin script), matching
how the project plan says roles are meant to be managed.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends

from app.schemas import UserBootstrapRequest, UserProfile
from app.services.firebase_service import get_current_user, get_db

router = APIRouter(prefix="/users", tags=["users"])


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _profile_from_doc(uid: str, data: dict) -> UserProfile:
    return UserProfile(
        uid=uid,
        email=data.get("email"),
        display_name=data.get("display_name"),
        role=data.get("role", "user"),
        created_at=data.get("created_at"),
    )


@router.post("/bootstrap", response_model=UserProfile)
def bootstrap_user(payload: UserBootstrapRequest, user: dict = Depends(get_current_user)):
    """
    Idempotent — call this right after every sign-in AND every sign-up.
    Creates `users/{uid}` with role="user" the first time it's seen;
    on every later call it just refreshes email/display_name (in case the
    user changed them in Firebase Auth) and returns the existing profile,
    role untouched.
    """
    db = get_db()
    ref = db.collection("users").document(user["uid"])
    doc = ref.get()

    email = user.get("email")
    # Google sign-in puts a name on the token itself; email/password accounts
    # rely on the frontend passing display_name explicitly after signup.
    display_name = payload.display_name or user.get("name")

    if not doc.exists:
        data = {
            "uid": user["uid"],
            "email": email,
            "display_name": display_name,
            "role": "user",
            "created_at": _now_iso(),
        }
        ref.set(data)
        return _profile_from_doc(user["uid"], data)

    data = doc.to_dict()
    updates = {}
    if email and email != data.get("email"):
        updates["email"] = email
    if display_name and display_name != data.get("display_name"):
        updates["display_name"] = display_name
    if updates:
        ref.update(updates)
        data.update(updates)
    return _profile_from_doc(user["uid"], data)


@router.get("/me", response_model=UserProfile)
def get_me(user: dict = Depends(get_current_user)):
    """Read-only profile fetch (role included) — call this on app load to
    decide what nav/routes to show, instead of re-running bootstrap writes
    on every page."""
    db = get_db()
    doc = db.collection("users").document(user["uid"]).get()
    if not doc.exists:
        # Shouldn't normally happen (bootstrap runs right after auth), but
        # fall back to a plain "user" profile rather than erroring the UI out.
        return UserProfile(uid=user["uid"], email=user.get("email"), role="user")
    return _profile_from_doc(user["uid"], doc.to_dict())
