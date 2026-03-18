# Groceries Order Tracking

A full-stack application for tracking grocery orders and price trends, specifically integrated with the **Knuspr** (German online supermarket) API.

## Project Overview

*   **Purpose:** Allows users to import their Knuspr order history and visualize spending patterns and product price trends over time.
*   **Architecture:**
    *   **Frontend:** A modern SPA built with **SolidJS**, utilizing **Tailwind CSS** and **DaisyUI** for styling, and **Chart.js** for data visualization.
    *   **Backend:** A **Node.js/Express** server that handles authentication, Knuspr API integration, and data persistence.
    *   **Database:** **MongoDB** (via Mongoose) stores user credentials and imported order details.
*   **Key Features:**
    *   JWT-based authentication (stored in cookies).
    *   Knuspr order importer that parses `curl` commands to extract session headers/cookies.
    *   Aggregated dashboard showing spending over time.
    *   Product-specific price trend analysis.

## Tech Stack

*   **Frontend:** SolidJS, @solidjs/router, Chart.js, Lucide-Solid, Tailwind CSS, DaisyUI.
*   **Backend:** Express, Mongoose, JSON Web Token (JWT), Cookie-parser, TSX (for TypeScript execution).
*   **Development Tools:** Vite, TypeScript, Concurrently.

## Getting Started

### Prerequisites

*   Node.js (v18+ recommended)
*   MongoDB instance (running locally or via Atlas)

> **Security Note:** `src/lib/mongodb.ts` currently contains a hardcoded MongoDB connection string. This should be moved to an environment variable (`MONGODB_URI`).

### Building and Running

*   **Install Dependencies:**
    ```bash
    npm install
    ```
*   **Development Mode (Frontend + Backend):**
    ```bash
    npm run dev
    ```
    This starts the Vite dev server for the frontend and `tsx watch` for the backend concurrently.
*   **Production Build:**
    ```bash
    npm run build
    ```
*   **Preview Production Build:**
    ```bash
    npm run serve
    ```

## Project Structure

*   `src/api/`: Express server, routes, and controllers (auth, orders).
*   `src/frontend/`: SolidJS components, pages (Dashboard, Orders, Products, Import), and routing.
*   `src/models/`: Mongoose schemas for `User` and `Order`.
*   `src/lib/`:
    *   `mongodb.ts`: Database connection logic.
    *   `order-importer.ts`: Logic for fetching and parsing data from the Knuspr API.

## Development Conventions

*   **File Extensions:** Use `.tsx` for SolidJS components and `.ts` for backend/logic files.
*   **API Routes:** All backend API endpoints should be prefixed with `/api`.
*   **Authentication:** Protected routes in the backend use the `auth` middleware, which expects a `token` cookie.
*   **Data Integrity:** Orders are unique per user based on their Knuspr order ID (`id`).
