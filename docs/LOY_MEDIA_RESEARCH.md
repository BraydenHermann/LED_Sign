# LOY SPACE Media, Authentication & Upload Research Notes

## Overview
This document summarizes our research into the LOY SPACE cloud backend and mobile application (`com.yskj.loy.apk` / `com.yskj.loyplay.apk`). It details the protocol for querying the shared media gallery, user authentication mechanisms, guest/tourist mode, and how media is uploaded and published to the shared downloads area.

---

## 1. Cloud Architecture & Endpoints

All cloud requests interface directly with PopLED's public HTTP/HTTPS APIs:

| Endpoint Base | Purpose | Authentication |
|---|---|---|
| `https://wxbtapp-cdn.popled.cn/` | Primary API (Gallery queries, User Auth, Material Upload & Share) | Form-Data with MD5 signature token |
| `https://store-cdn.popled.cn/` | Secondary / Asset Store API | Form-Data with MD5 signature token |
| `https://lmq6store.popled.cn/` | Public Media CDN (Images, GIFs, Avatars) | Direct HTTP GET |
| `https://auth.popled.cn/` | Device and app version checking | MD5 signature token |

### Request Signing & Security Tokens
Requests to `wxbtapp-cdn.popled.cn` include two validation parameters:
- `ts`: Current Unix timestamp in seconds (`Math.floor(Date.now() / 1000)`).
- `token`: MD5 hash of the parameters concatenated with the secret app key:
  ```
  token = md5(sorted_key_value_pairs + SECRET_KEY)
  ```
- **App Key / Secret**:
  - `app_key`: `055f4a2a6c9a7ab47958b4ea9d236e1c`
  - `MD5_key`: `Z2cjvaB8mbICRoDqvS9X8D3ubz2ecbAn`

---

## 2. Authentication & Pricing Analysis

### Developer Fees / Paid APIs
- **There are NO developer fees, subscription plans, or paid API keys.**
- The PopLED infrastructure is free to access and supports both mobile devices and external clients.

### Authentication Methods

#### A. Guest / Tourist Mode (`touristModel`) — *Recommended*
The official LOY SPACE app provides an anonymous "Tourist Mode" that automatically creates a valid user profile on first launch without requiring an email, phone number, or SMS verification:

1. **Device ID Generation**: A unique identifier is generated (e.g., standard UUID).
2. **Login Attempt**:
   ```http
   POST https://wxbtapp-cdn.popled.cn/login
   Content-Type: multipart/form-data

   user=<deviceId>&pwd=md5(<deviceId>)&ts=<timestamp>&token=<token>
   ```
3. **Automatic Registration**:
   - If the account does not exist (Status `202`), the client immediately calls:
     ```http
     POST https://wxbtapp-cdn.popled.cn/register
     Content-Type: multipart/form-data

     user=<deviceId>&pwd=md5(<deviceId>)&ts=<timestamp>&token=<token>
     ```
   - The server registers the device as a legitimate user, returning:
     ```json
     {
       "status": 0,
       "data": {
         "userid": 123456,
         "key": "...",
         "session_key": "..."
       }
     }
     ```
4. **Profile Initialization**:
   - The app sets a default nickname (`"Tourist_" + randomString(10)`) and default avatar using `POST /update_user`.
5. **Capabilities**:
   - **Crucially, the backend does not restrict tourists from uploading or sharing media.** Tourist accounts possess a valid `userid` and can upload files and submit them to the community gallery.

#### B. Existing Mobile Account Login (`/login`)
If a user already registered an account in the LOY SPACE mobile app:
- Endpoint: `POST https://wxbtapp-cdn.popled.cn/login`
- Body: `user=<phone_or_email>`, `pwd=md5(<password>)`
- Returns: User credentials (`userid`, `key`, `nickname`, `image_url`).
- **No SMS verification or captcha is required** when logging into an existing account.

#### C. New Account Registration with Phone or Email (`/register`)
Registering a brand new non-tourist account requires:
- Solving a Tencent/PopLED sliding puzzle captcha (`https://a.popled.cn/mb/tncode/`).
- Receiving a verification code via SMS (`/send_checkcode_sms` — largely restricted to Chinese +86 carriers) or SMTP email (`/send_checkcode_smtp`).
- Submitting the verification code along with `user` and `pwd` to `/register`.
- *Note*: Because SMS verification is geared toward mainland Chinese carriers, phone registration is cumbersome for international users; email or Guest Mode is vastly preferred.

---

## 3. Media Upload & Gallery Sharing Protocol

When a user in the mobile app creates or exports a custom animation/image and shares it with the community:

### Step 1: Uploading the Media File (`POST /material_upload`)
- **URL**: `https://wxbtapp-cdn.popled.cn/material_upload`
- **Method**: `POST` (`multipart/form-data`)
- **Fields**:
  - `file`: The image file (PNG, JPG, or GIF binary)
  - `userid`: The user's ID (obtained from Guest registration or login)
  - `w`: Width (e.g. `64`)
  - `h`: Height (e.g. `20`)
  - `name`: Name for the media (string)
  - `mark`: Description / tags (string)
  - `resize`: `0` (do not resize)
  - `nodb`: `1`
  - `ts`: Timestamp
  - `token`: MD5 signature
- **Response**:
  ```json
  {
    "status": 0,
    "data": {
      "id": 987654,
      "url": "https://lmq6store.popled.cn/Public/Upload/allmaterial/..."
    }
  }
  ```

### Step 2: Publishing to the Shared Gallery (`POST /material_share`)
- **URL**: `https://wxbtapp-cdn.popled.cn/material_share`
- **Method**: `POST` (`multipart/form-data`)
- **Fields**:
  - `userid`: The user's ID
  - `mids`: JSON array or list of material IDs to share (e.g. `[987654]`)
  - `ts`: Timestamp
  - `token`: MD5 signature
- **Result**:
  - The uploaded material enters the LOY community database/review queue and is cataloged under the appropriate dimension category (e.g., `64x20`).

---

## 4. Querying the Shared Downloads Gallery

### Fetching Categories
- **URL**: `POST https://store-cdn.popled.cn/api/material/get_category_all`
- Maps category names ("Eye", "Motorcycle", "Expression", "Holidays", etc.) to `id_res` category IDs.

### Fetching Filtered Media Items
- **URL**: `POST https://wxbtapp-cdn.popled.cn/material_select`
- **Parameters**:
  - `type`: `0` for Newest/Recommended, `1` for specific category tabs
  - `id_res`: Category ID (e.g. `13` for Eye, `14` for Motorcycle)
  - `w`: `64`
  - `h`: `20`
  - `page`: Page index (1-based)
  - `pagesize`: Number of items (e.g. 20)
  - `find`: Search query string (optional)

---

## 5. Implementation Roadmap for LEDSign Web App

1. **Downloads Gallery**:
   - Implemented via `LoySpaceGallery.jsx` side panel.
   - Filtered exclusively to `64 × 20` material size.
   - Backed by `server/loy_space_service.py` with caching and CORS proxying.

2. **Upload & Publish Integration (Future Phase)**:
   - **Phase 1: Seamless Guest Session**:
     - The server provisions a persistent guest user account via `touristModel` (storing `userid` and session keys in server config).
     - Allows instant 1-click "Share to LOY SPACE" directly from the preset media editor without prompting the user for any credentials.
   - **Phase 2: Optional Mobile Account Login**:
     - Add a "Connect LOY Account" modal in settings where users who already have an account in the mobile app can enter their email/phone and password to attribute uploads directly to their profile.
