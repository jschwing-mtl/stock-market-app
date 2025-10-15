// --- IMPORTS ---
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const { OpenAI } = require('openai');

// --- CONSTANTS ---
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// --- DATABASE CONNECTION ---
let cachedDb = null;
async function connectToDatabase() {
    if (cachedDb) return cachedDb;
    const client = await MongoClient.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    const db = client.db('stock-market-app');
    cachedDb = db;
    return db;
}

// --- HELPER FUNCTIONS ---
const sendResponse = (data) => ({ statusCode: 200, body: JSON.stringify({ data }) });
const sendError = (message, statusCode = 500) => ({ statusCode, body: JSON.stringify({ message }) });

// --- OPENAI API CALLER ---
async function callAiApi(systemPrompt, userQuery) {
    if (!OPENAI_API_KEY) {
        console.warn("OPENAI_API_KEY is not set.");
        throw new Error("The AI features are not configured. Please add an OpenAI API key.");
    }
    try {
        const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
        const chatCompletion = await openai.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userQuery },
            ],
            model: 'gpt-3.5-turbo',
        });
        return chatCompletion.choices[0].message.content;
    } catch (error) {
        console.error("OpenAI API Error:", error);
        throw new Error("Failed to call OpenAI API.");
    }
}

// --- MAIN HANDLER ---
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return sendError('Method Not Allowed', 405);

    try {
        const db = await connectToDatabase();
        const { action, payload, token } = JSON.parse(event.body);
        const protectedActions = ['validateSession', 'getPortfolio', 'executeTrade', 'getStudentRoster', 'addStudent', 'removeStudent', 'updateStudentCash', 'getCachedNews', 'setCachedNews', 'simplifyNews', 'getCompanyExplanation', 'getPortfolioAnalysis', 'intelligentSearch'];
        let session = null;

        if (protectedActions.includes(action)) {
            if (!token) return sendError('Authorization token is missing.', 401);
            try {
                session = jwt.verify(token, JWT_SECRET);
                session.userId = new ObjectId(session.userId);
            } catch (err) {
                return sendError('Invalid or expired session.', 401);
            }
        }
        
        switch (action) {
            case 'registerUser': {
                const { username, password, isTeacher } = payload;
                if (!username || !password) return sendError('Username and password are required.', 400);
                const users = db.collection('users');
                if (await users.findOne({ username })) return sendError('Username already exists.', 409);
                const hashedPassword = await bcrypt.hash(password, 10);
                const role = isTeacher ? 'teacher' : 'student';
                const newUserResult = await users.insertOne({ username, hashedPassword, role, teacherId: isTeacher ? null : undefined });
                await db.collection('portfolios').insertOne({ userId: newUserResult.insertedId, cash: 100000, stocks: [] });
                return sendResponse({ username });
            }

            case 'loginUser': {
                const { username, password } = payload;
                const user = await db.collection('users').findOne({ username });
                if (!user || !(await bcrypt.compare(password, user.hashedPassword))) {
                    return sendError('Invalid username or password.', 401);
                }
                const sessionToken = jwt.sign({ userId: user._id.toString(), username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
                return sendResponse({ token: sessionToken, userData: { userId: user._id, username: user.username, role: user.role } });
            }
                
            case 'validateSession':
                return sendResponse({ userData: { ...session, userId: session.userId.toString() } });

            case 'getPortfolio': {
                const portfolio = await db.collection('portfolios').findOne({ userId: session.userId });
                return sendResponse(portfolio);
            }
            
            case 'executeTrade': {
                const { type, symbol, quantity, price } = payload;
                const portfolios = db.collection('portfolios');
                const portfolio = await portfolios.findOne({ userId: session.userId });
                let { cash, stocks = [] } = portfolio;
                if (type === 'buy') {
                    const cost = quantity * price;
                    if (cost > cash) return sendError('Not enough cash.', 400);
                    cash -= cost;
                    const stockIndex = stocks.findIndex(s => s.symbol === symbol);
                    if (stockIndex > -1) {
                         const existing = stocks[stockIndex];
                         const newTotalShares = existing.shares + quantity;
                         const newTotalValue = (existing.shares * existing.purchasePrice) + cost;
                         existing.purchasePrice = newTotalValue / newTotalShares;
                         existing.shares = newTotalShares;
                    } else {
                        stocks.push({ symbol, shares: quantity, purchasePrice: price, purchaseDate: Math.floor(Date.now() / 1000) });
                    }
                } else if (type === 'sell') {
                    const stockIndex = stocks.findIndex(s => s.symbol === symbol);
                    if (stockIndex === -1 || stocks[stockIndex].shares < quantity) return sendError('Not enough shares to sell.', 400);
                    cash += quantity * price;
                    stocks[stockIndex].shares -= quantity;
                    if (stocks[stockIndex].shares === 0) stocks.splice(stockIndex, 1);
                } else return sendError('Invalid trade type.', 400);
                await portfolios.updateOne({ userId: session.userId }, { $set: { cash, stocks } });
                return sendResponse({ success: true });
            }

            case 'addStudent': {
                if (session.role !== 'teacher') return sendError('Access denied.', 403);
                const { username, password, startingCash } = payload;
                const users = db.collection('users');
                if (await users.findOne({ username })) return sendError('Username already exists.', 409);
                const hashedPassword = await bcrypt.hash(password, 10);
                const newUserResult = await users.insertOne({ username, hashedPassword, role: 'student', teacherId: session.userId });
                await db.collection('portfolios').insertOne({ userId: newUserResult.insertedId, cash: startingCash, stocks: [] });
                return sendResponse({ success: true });
            }

            case 'removeStudent': {
                if (session.role !== 'teacher') return sendError('Access denied.', 403);
                const studentId = new ObjectId(payload.studentId);
                const student = await db.collection('users').findOne({ _id: studentId, teacherId: session.userId });
                if (!student) return sendError('Student not found or you do not have permission to remove them.', 404);
                await db.collection('users').deleteOne({ _id: studentId });
                await db.collection('portfolios').deleteOne({ userId: studentId });
                return sendResponse({ success: true });
            }

            case 'updateStudentCash': {
                if (session.role !== 'teacher') return sendError('Access denied.', 403);
                const studentId = new ObjectId(payload.studentId);
                const student = await db.collection('users').findOne({ _id: studentId, teacherId: session.userId });
                if (!student) return sendError('Student not found or you do not have permission.', 404);
                await db.collection('portfolios').updateOne({ userId: studentId }, { $inc: { cash: payload.amount } });
                return sendResponse({ success: true });
            }
                
            case 'getStudentRoster': {
                 if (session.role !== 'teacher') return sendError('Access denied.', 403);
                 const students = await db.collection('users').aggregate([
                     { $match: { role: 'student', teacherId: session.userId } },
                     { $lookup: { from: 'portfolios', localField: '_id', foreignField: 'userId', as: 'portfolio' } },
                     { $unwind: '$portfolio' },
                     { $project: { username: 1, cash: '$portfolio.cash' } }
                 ]).toArray();
                 return sendResponse(students);
            }

            case 'getCachedNews': {
                const cache = await db.collection('newsCache').findOne({ headline: payload.headline });
                return sendResponse(cache);
            }

            case 'setCachedNews': {
                 await db.collection('newsCache').updateOne({ headline: payload.headline }, { $set: { simplifiedText: payload.simplifiedText, timestamp: new Date() } }, { upsert: true });
                 return sendResponse({ success: true });
            }

            case 'intelligentSearch': {
                const systemPrompt = "You are an AI assistant for a stock market app. The user will provide a search query (a product, company name, industry, or keyword). Your task is to identify the most relevant publicly traded company on a major US exchange (like NYSE or NASDAQ) and return ONLY its stock symbol. If you are unsure or can't find a direct match, return 'NO_MATCH'. For example, if the query is 'iphone', you should return 'AAPL'. If the query is 'electric cars with self-driving', return 'TSLA'.";
                const symbol = await callAiApi(systemPrompt, payload.query);
                if (symbol.trim().toUpperCase() === 'NO_MATCH' || symbol.length > 5) return sendResponse([]);
                const finnhubRes = await fetch(`https://finnhub.io/api/v1/search?q=${symbol.trim()}&token=${FINNHUB_API_KEY}`);
                const finnhubData = await finnhubRes.json();
                const exactMatch = finnhubData.result.filter(r => r.symbol === symbol.trim().toUpperCase());
                return sendResponse(exactMatch.length > 0 ? exactMatch : finnhubData.result.slice(0,1));
            }

            case 'simplifyNews': {
                const systemPrompt = "You are an expert at simplifying news for 4th graders. Rewrite the following news summary in simple, easy-to-understand language. Explain what it means for the company. Output only the simplified text.";
                const userQuery = `Headline: ${payload.headline}\nSummary: ${payload.summary}`;
                const simplifiedText = await callAiApi(systemPrompt, userQuery);
                return sendResponse({ simplifiedText });
            }

            case 'getCompanyExplanation': {
                const { companyName, symbol } = payload;
                const cache = await db.collection('explanationCache').findOne({ symbol });
                if (cache) return sendResponse({ explanation: cache.explanation });
                const systemPrompt = "You are an expert at explaining what a company does in simple, kid-friendly terms for a 4th grader. Use an analogy if possible. Keep it to one short paragraph. Do not give financial advice. Mention some of its famous products or services. Output only the explanation text.";
                const userQuery = `Explain what the company "${companyName}" (${symbol}) does.`;
                const explanation = await callAiApi(systemPrompt, userQuery);
                await db.collection('explanationCache').insertOne({ symbol, explanation, timestamp: new Date() });
                return sendResponse({ explanation });
            }
                
            case 'getPortfolioAnalysis': {
                 const systemPrompt = "You are a friendly and encouraging financial coach for kids. Your role is to look at a student's stock portfolio and provide simple, positive feedback. Explain concepts like diversification (having different kinds of stocks) and performance in easy-to-understand terms. DO NOT give financial advice or tell them to buy or sell specific stocks. Keep the analysis to 2-3 short paragraphs. Address the student by name.";
                 const userQuery = `Here is ${session.username}'s portfolio summary: ${JSON.stringify(payload.portfolioSummary)}. Please provide a simple analysis.`;
                 const analysis = await callAiApi(systemPrompt, userQuery);
                 return sendResponse({ analysis });
            }

            default:
                return sendError('Unknown action.', 404);
        }

    } catch (error) {
        console.error('SERVER ERROR:', error);
        return sendError('An internal server error occurred.');
    }
};

