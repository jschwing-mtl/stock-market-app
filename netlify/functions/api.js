// --- IMPORTS ---
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// --- CONSTANTS ---
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const INITIAL_CASH = 100000;

// --- DATABASE CONNECTION ---
let cachedDb = null;
async function connectToDatabase() {
    if (cachedDb) {
        return cachedDb;
    }
    const client = await MongoClient.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    const db = client.db('stock-market-app'); // You can name your database here
    cachedDb = db;
    return db;
}

// --- HELPER FUNCTIONS ---
const sendResponse = (data, statusCode = 200) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
});

const sendError = (message, statusCode = 500) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
});


// --- MAIN HANDLER ---
exports.handler = async (event, context) => {
    // We only accept POST requests
    if (event.httpMethod !== 'POST') {
        return sendError('Method Not Allowed', 405);
    }

    try {
        const db = await connectToDatabase();
        const { action, payload, token } = JSON.parse(event.body);

        // --- AUTHENTICATION & MIDDLEWARE ---
        const protectedActions = ['validateSession', 'getPortfolio', 'executeTrade', 'getStudentRoster', 'getCachedNews', 'setCachedNews', 'simplifyNews', 'getCompanyExplanation', 'getPortfolioAnalysis'];
        let session = null;

        if (protectedActions.includes(action)) {
            if (!token) return sendError('Authorization token is missing.', 401);
            try {
                session = jwt.verify(token, JWT_SECRET);
            } catch (err) {
                return sendError('Invalid or expired session.', 401);
            }
        }
        
        // --- ACTION ROUTER ---
        switch (action) {
            case 'registerUser': {
                const { username, password, isTeacher } = payload;
                if (!username || !password) return sendError('Username and password are required.', 400);
                
                const usersCollection = db.collection('users');
                const existingUser = await usersCollection.findOne({ username });
                if (existingUser) return sendError('Username already exists.', 409);

                const hashedPassword = await bcrypt.hash(password, 10);
                const role = isTeacher ? 'teacher' : 'student';

                const newUserResult = await usersCollection.insertOne({ username, hashedPassword, role });
                
                const portfoliosCollection = db.collection('portfolios');
                await portfoliosCollection.insertOne({ userId: newUserResult.insertedId, cash: INITIAL_CASH, stocks: [] });

                return sendResponse({ data: { username } });
            }

            case 'loginUser': {
                const { username, password } = payload;
                if (!username || !password) return sendError('Username and password are required.', 400);

                const user = await db.collection('users').findOne({ username });
                if (!user || !(await bcrypt.compare(password, user.hashedPassword))) {
                    return sendError('Invalid username or password.', 401);
                }
                
                const sessionToken = jwt.sign({ userId: user._id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
                
                return sendResponse({ data: { token: sessionToken, userData: { userId: user._id, username: user.username, role: user.role } } });
            }
                
            case 'validateSession':
                return sendResponse({ data: { userData: session } });

            case 'getPortfolio': {
                const portfolio = await db.collection('portfolios').findOne({ userId: session.userId });
                return sendResponse({ data: portfolio });
            }
            
            case 'executeTrade': {
                const { type, symbol, quantity, price } = payload;
                const portfolios = db.collection('portfolios');
                const portfolio = await portfolios.findOne({ userId: session.userId });

                let cash = portfolio.cash;
                let stocks = portfolio.stocks || [];
                
                if (type === 'buy') {
                    const cost = quantity * price;
                    if (cost > cash) return sendError('Not enough cash.', 400);
                    cash -= cost;
                    const stockIndex = stocks.findIndex(s => s.symbol === symbol);
                    if (stockIndex > -1) {
                         stocks[stockIndex].shares += quantity;
                    } else {
                        stocks.push({ symbol, shares: quantity, purchasePrice: price, purchaseDate: Math.floor(Date.now() / 1000) });
                    }
                } else if (type === 'sell') {
                    const stockIndex = stocks.findIndex(s => s.symbol === symbol);
                    if (stockIndex === -1 || stocks[stockIndex].shares < quantity) return sendError('Not enough shares to sell.', 400);
                    cash += quantity * price;
                    stocks[stockIndex].shares -= quantity;
                    if (stocks[stockIndex].shares === 0) {
                        stocks = stocks.filter(s => s.symbol !== symbol);
                    }
                } else {
                    return sendError('Invalid trade type.', 400);
                }

                await portfolios.updateOne({ userId: session.userId }, { $set: { cash, stocks } });
                return sendResponse({ data: { success: true } });
            }

            case 'getStudentRoster': {
                 if (session.role !== 'teacher') return sendError('Access denied.', 403);
                 const students = await db.collection('users').find({ role: 'student' }).project({ username: 1, _id: 1 }).toArray();
                 return sendResponse({ data: students });
            }

            case 'getCachedNews': {
                const cache = await db.collection('newsCache').findOne({ headline: payload.headline });
                return sendResponse({ data: cache });
            }

            case 'setCachedNews': {
                 await db.collection('newsCache').updateOne(
                     { headline: payload.headline },
                     { $set: { simplifiedText: payload.simplifiedText, timestamp: new Date() } },
                     { upsert: true }
                 );
                 return sendResponse({ data: { success: true } });
            }
                
            // --- GEMINI ACTIONS ---
            // These would require a Gemini API key set as an environment variable
            case 'simplifyNews': {
                const { headline, summary } = payload;
                // In a real app, you'd call the Gemini API here.
                const simplifiedText = `This news means that ${headline.split(' ')[0]} is doing something interesting! For a company, new things can change how much people think it's worth, which can make the stock price go up or down.`;
                return sendResponse({ data: { simplifiedText } });
            }

            case 'getCompanyExplanation': {
                const { companyName } = payload;
                const explanation = `The company ${companyName} is like a giant factory that makes things lots of people want to buy. When many people buy their products, the company does well, and its stock might become more valuable.`;
                return sendResponse({ data: { explanation } });
            }
                
            case 'getPortfolioAnalysis': {
                 const { portfolioSummary } = payload;
                 const analysis = `Hi ${session.username}! It looks like you're off to a great start. You have some cash ready to invest and some stocks. It's cool to own pieces of different companies. Keep watching to see how they do!`;
                 return sendResponse({ data: { analysis } });
            }

            default:
                return sendError('Unknown action.', 404);
        }

    } catch (error) {
        console.error('SERVER ERROR:', error);
        return sendError('An internal server error occurred.');
    }
};

