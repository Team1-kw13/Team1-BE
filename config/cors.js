const cors = require("cors");

const corsOptions = {
    origin: function (origin, callback) {
        const allowedOrigins = process.env.CLIENT_ORIGIN
            ? process.env.CLIENT_ORIGIN.split(",").map((origin) =>
                  origin.trim()
              )
            : ["http://localhost:3000", "http://localhost:3001"];

        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("CORS policy violation: Origin not allowed"));
        }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    optionsSuccessStatus: 200,
};

module.exports = cors(corsOptions);
