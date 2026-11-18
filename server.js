const express = require("express");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const MONGO_URL = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = "CampusLostAndFound";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let db;

const toObjectId = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);
const clean = (v) => (typeof v === "string" ? v.trim() : v);

// Keep only the fields we allow, and trim text values.
function pick(body, fields) {
  const out = {};
  for (const f of fields) {
    if (body[f] !== undefined && body[f] !== "") out[f] = clean(body[f]);
  }
  return out;
}

// ---------- Users ----------
app.get("/api/users", async (req, res) => {
  res.json(await db.collection("Users").find().toArray());
});

app.post("/api/users", async (req, res) => {
  const doc = pick(req.body, ["name", "email", "role"]);
  if (!doc.name) return res.status(400).json({ error: "Name is required." });
  const r = await db.collection("Users").insertOne(doc);
  res.status(201).json({ _id: r.insertedId, ...doc });
});

// ---------- Lost items ----------
app.get("/api/lost", async (req, res) => {
  res.json(await db.collection("LostItems").find().sort({ _id: -1 }).toArray());
});

app.post("/api/lost", async (req, res) => {
  const doc = pick(req.body, [
    "itemName", "description", "dateLost", "locationLost", "reportedBy", "userId",
  ]);
  if (!doc.itemName) return res.status(400).json({ error: "Item name is required." });
  doc.status = "lost";
  const r = await db.collection("LostItems").insertOne(doc);
  res.status(201).json({ _id: r.insertedId, ...doc });
});

// ---------- Found items ----------
app.get("/api/found", async (req, res) => {
  res.json(await db.collection("FoundItems").find().sort({ _id: -1 }).toArray());
});

app.post("/api/found", async (req, res) => {
  const doc = pick(req.body, [
    "itemName", "description", "dateFound", "locationFound", "foundBy",
  ]);
  if (!doc.itemName) return res.status(400).json({ error: "Item name is required." });
  doc.status = "unclaimed";
  const r = await db.collection("FoundItems").insertOne(doc);
  res.status(201).json({ _id: r.insertedId, ...doc });
});

// ---------- Claims ----------
// Returns each claim together with its user and found item (same idea as the Compass pipeline).
app.get("/api/claims", async (req, res) => {
  const toOid = (field) => ({
    $convert: { input: field, to: "objectId", onError: null, onNull: null },
  });
  const claims = await db
    .collection("Claims")
    .aggregate([
      { $addFields: { userObjId: toOid("$userId"), foundObjId: toOid("$foundItemId") } },
      { $lookup: { from: "Users", localField: "userObjId", foreignField: "_id", as: "user" } },
      { $lookup: { from: "FoundItems", localField: "foundObjId", foreignField: "_id", as: "foundItem" } },
      { $project: { userObjId: 0, foundObjId: 0 } },
      { $sort: { _id: -1 } },
    ])
    .toArray();
  res.json(claims);
});

app.post("/api/claims", async (req, res) => {
  const doc = pick(req.body, [
    "claimantName", "itemClaimed", "dateClaimed", "proofOfOwnership", "userId", "foundItemId",
  ]);
  if (!doc.claimantName || !doc.foundItemId) {
    return res.status(400).json({ error: "Your name and the found item are required." });
  }
  const found = await db.collection("FoundItems").findOne({ _id: toObjectId(doc.foundItemId) });
  if (!found) return res.status(400).json({ error: "That found item does not exist." });
  doc.itemClaimed = doc.itemClaimed || found.itemName;
  doc.status = "pending";
  const r = await db.collection("Claims").insertOne(doc);
  res.status(201).json({ _id: r.insertedId, ...doc });
});

// Approve or reject a claim. Approving also marks the found item as claimed.
app.patch("/api/claims/:id", async (req, res) => {
  const status = req.body.status;
  if (!["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "Status must be approved, rejected or pending." });
  }
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(400).json({ error: "Bad claim id." });

  const claim = await db.collection("Claims").findOneAndUpdate(
    { _id },
    { $set: { status } },
    { returnDocument: "after" }
  );
  if (!claim) return res.status(404).json({ error: "Claim not found." });

  const foundId = toObjectId(claim.foundItemId);
  if (foundId) {
    await db
      .collection("FoundItems")
      .updateOne({ _id: foundId }, { $set: { status: status === "approved" ? "claimed" : "unclaimed" } });
  }
  res.json(claim);
});

// Catch errors from the routes above so the server doesn't crash.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

MongoClient.connect(MONGO_URL)
  .then((client) => {
    db = client.db(DB_NAME);
    app.listen(PORT, () => {
      console.log(`Connected to MongoDB. Open http://localhost:${PORT} in your browser.`);
    });
  })
  .catch((err) => {
    console.error("Could not connect to MongoDB. Is it running on", MONGO_URL, "?");
    console.error(err.message);
    process.exit(1);
  });
