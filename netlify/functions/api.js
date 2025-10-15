const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const OpenAI = require('openai');

// --- UTILITY: A single, reusable database connection function ---
async function connectToDatabase() {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not defined in environment variables.');
    
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(); // The DB name is usually part of the URI, otherwise specify it here.
    return { db, client };
}

// --- MAIN HANDLER for Netlify serverless function ---
exports.handler = async (event) => {
    // Only accept POST requests
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { db, client } = await connectToDatabase();
    const usersCollection = db.collection('users');
    
    try {
        const { action, payload, token } = JSON.parse(event.body);
        let userData;

        // --- AUTHENTICATION: Verify token for protected actions ---
        const protectedActions = [
            'getPortfolio', 'executeTrade', 'getStudentRoster', 'addStudent', 'removeStudent',
            'updateStudentCash', 'getQuotes', 'getCompanyNews', 'simplifyNews', 'setCachedNews',
            'intelligentSearch', 'getCompanyExplanation', 'getPortfolioAnalysis', 'getChartData',
            'validateSession'
        ];

        if (protectedActions.includes(action)) {
            if (!token) throw new Error('Authentication token is required.');
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            userData = { userId: decoded.userId, username: decoded.username, role: decoded.role };
            if (!userData) throw new Error('Invalid or expired session.');
        }

        // --- ACTION ROUTER: Handle different API calls ---
        let responseData;
        switch (action) {
            // User Management
            case 'registerUser':
                responseData = await registerUser(usersCollection, payload);
                break;
            case 'loginUser':
                responseData = await loginUser(usersCollection, payload);
                break;
            case 'validateSession':
                responseData = userData;
                break;
            // Teacher/Roster Management
            case 'addStudent':
                if (userData.role !== 'teacher') throw new Error('Access Denied');
                responseData = await addStudent(usersCollection, { ...payload, teacherId: userData.userId });
                break;
            case 'getStudentRoster':
                if (userData.role !== 'teacher') throw new Error('Access Denied');
                responseData = await getStudentRoster(usersCollection, userData.userId);
                break;
            case 'removeStudent':
                if (userData.role !== 'teacher') throw new Error('Access Denied');
                responseData = await removeStudent(usersCollection, payload.studentId, userData.userId);
                break;
            case 'updateStudentCash':
                 if (userData.role !== 'teacher') throw new Error('Access Denied');
                 responseData = await updateStudentCash(usersCollection, payload.studentId, payload.amount, userData.userId);
                 break;
            // Portfolio Management
            case 'getPortfolio':
                responseData = await getPortfolio(usersCollection, userData.userId);
                break;
            case 'executeTrade':
                responseData = await executeTrade(usersCollection, userData.userId, payload);
                break;
            // Finnhub Data Proxy
            case 'getQuotes':
                responseData = await getQuotes(payload.symbols);
                break;
            case 'getCompanyNews':
                 responseData = await getCompanyNews(db.collection('newsCache'), payload.symbols);
                 break;
            case 'getChartData':
                responseData = await getChartData(payload.symbol, payload.from, payload.to);
                break;
            // AI Features & Caching
            case 'intelligentSearch':
                responseData = await intelligentSearch(payload.query);
                break;
            case 'getCompanyExplanation':
                responseData = await getCompanyExplanation(db.collection('explanationCache'), payload.companyName, payload.symbol);
                break;
            case 'simplifyNews':
                responseData = await simplifyNews(payload.headline, payload.summary);
                break;
            case 'setCachedNews': // Caching is now handled within simplifyNews logic, but we keep this case for now.
                 await db.collection('newsCache').updateOne({ headline: payload.headline }, { $set: { simplifiedText: payload.simplifiedText } }, { upsert: true });
                 responseData = { success: true };
                 break;
            case 'getPortfolioAnalysis':
                responseData = await getPortfolioAnalysis(userData.username, payload.portfolioSummary);
                break;
            default:
                throw new Error(`Unknown action: ${action}`);
        }
        
        return { statusCode: 200, body: JSON.stringify({ data: responseData }) };

    } catch (error) {
        console.error('API Error:', error);
        return { statusCode: 500, body: JSON.stringify({ message: error.message }) };
    } finally {
        await client.close();
    }
};


// --- AUTHENTICATION & USER FUNCTIONS ---

async function registerUser(collection, { username, password, isTeacher }) {
    if (!username || !password) throw new Error('Username and password are required.');
    // Case-insensitive check for existing user
    const existingUser = await collection.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (existingUser) throw new Error('Username already exists.');

    const hashedPassword = await bcrypt.hash(password, 10);
    const role = isTeacher ? 'teacher' : 'student';

    const newUser = {
        username,
        hashedPassword,
        role,
        cash: role === 'student' ? 100000 : 0, // Teachers don't have portfolios
        stocks: [],
        teacherId: null, // Set for students when added by a teacher
    };
    await collection.insertOne(newUser);
    return { success: true, message: 'User registered successfully.' };
}

async function loginUser(collection, { username, password }) {
    if (!username || !password) throw new Error('Username and password are required.');
    // Case-insensitive search for user
    const user = await collection.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (!user) throw new Error('Invalid credentials.');

    const isMatch = await bcrypt.compare(password, user.hashedPassword);
    if (!isMatch) throw new Error('Invalid credentials.');

    const token = jwt.sign(
        { userId: user._id, username: user.username, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: '12h' }
    );
    return { token, userData: { userId: user._id, username: user.username, role: user.role } };
}


// --- TEACHER & ROSTER FUNCTIONS ---

async function addStudent(collection, { username, password, startingCash, teacherId }) {
    const existingUser = await collection.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (existingUser) throw new Error('Username already exists.');
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const newStudent = {
        username,
        hashedPassword,
        role: 'student',
        cash: startingCash || 100000,
        stocks: [],
        teacherId: new ObjectId(teacherId),
    };
    await collection.insertOne(newStudent);
    return newStudent;
}

async function getStudentRoster(collection, teacherId) {
    const students = await collection.find({ teacherId: new ObjectId(teacherId) }).project({ hashedPassword: 0 }).toArray();
    return students;
}

async function removeStudent(collection, studentId, teacherId) {
    const result = await collection.deleteOne({ _id: new ObjectId(studentId), teacherId: new ObjectId(teacherId) });
    if (result.deletedCount === 0) throw new Error('Student not found or you do not have permission to remove them.');
    return { success: true };
}

async function updateStudentCash(collection, studentId, amount, teacherId) {
    const result = await collection.updateOne(
        { _id: new ObjectId(studentId), teacherId: new ObjectId(teacherId) },
        { $inc: { cash: amount } }
    );
    if (result.matchedCount === 0) throw new Error('Student not found or you do not have permission to update them.');
    return { success: true };
}


// --- PORTFOLIO & TRADING FUNCTIONS ---

async function getPortfolio(collection, userId) {
    const user = await collection.findOne({ _id: new ObjectId(userId) }, { projection: { cash: 1, stocks: 1 } });
    if (!user) throw new Error('User not found.');
    return user;
}

async function executeTrade(collection, userId, { type, symbol, quantity, price }) {
    const user = await collection.findOne({ _id: new ObjectId(userId) });
    if (!user) throw new Error('User not found.');

    let { cash, stocks } = user;
    stocks = stocks || [];

    if (type === 'buy') {
        const totalCost = quantity * price;
        if (totalCost > cash) throw new Error('Not enough cash.');
        
        cash -= totalCost;
        const existingStock = stocks.find(s => s.symbol === symbol);
        if (existingStock) {
            const newTotalShares = existingStock.shares + quantity;
            const newPurchaseValue = (existingStock.shares * existingStock.purchasePrice) + totalCost;
            existingStock.purchasePrice = newPurchaseValue / newTotalShares;
            existingStock.shares = newTotalShares;
        } else {
            stocks.push({ symbol, shares: quantity, purchasePrice: price, purchaseDate: Math.floor(Date.now() / 1000) });
        }
    } else if (type === 'sell') {
        const existingStock = stocks.find(s => s.symbol === symbol);
        if (!existingStock || existingStock.shares < quantity) throw new Error('Not enough shares to sell.');
        
        cash += quantity * price;
        existingStock.shares -= quantity;
        if (existingStock.shares === 0) {
            stocks = stocks.filter(s => s.symbol !== symbol);
        }
    } else {
        throw new Error('Invalid trade type.');
    }
    
    await collection.updateOne({ _id: new ObjectId(userId) }, { $set: { cash, stocks } });
    return { success: true };
}


// --- FINNHUB DATA PROXY FUNCTIONS ---
// These functions call the Finnhub API from the backend to hide the API key.

async function finnhubApiCall(endpoint) {
    const finnhubKey = process.env.FINNHUB_API_KEY;
    if (!finnhubKey) throw new Error('Finnhub API key is not configured on the server.');
    const url = `https://finnhub.io/api/v1/${endpoint}&token=${finnhubKey}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch data from Finnhub.');
    return response.json();
}

async function getQuotes(symbols) {
    const quotePromises = symbols.map(symbol => finnhubApiCall(`quote?symbol=${symbol}`).then(quote => ({ [symbol]: quote })));
    const quotesArray = await Promise.all(quotePromises);
    return Object.assign({}, ...quotesArray);
}

async function getCompanyNews(cacheCollection, symbols) {
    const today = new Date();
    const oneMonthAgo = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate());
    const from = oneMonthAgo.toISOString().split('T')[0];
    const to = today.toISOString().split('T')[0];
    const newsPromises = symbols.map(symbol => finnhubApiCall(`company-news?symbol=${symbol}&from=${from}&to=${to}`));
    const allNewsArrays = await Promise.all(newsPromises);
    let allNews = [].concat(...allNewsArrays).slice(0, 10);

    // Check cache for simplified text
    const headlines = allNews.map(n => n.headline);
    const cachedItems = await cacheCollection.find({ headline: { $in: headlines } }).toArray();
    const cacheMap = new Map(cachedItems.map(item => [item.headline, item.simplifiedText]));

    allNews.forEach(newsItem => {
        if (cacheMap.has(newsItem.headline)) {
            newsItem.simplifiedText = cacheMap.get(newsItem.headline);
        }
    });
    
    return allNews;
}

async function getChartData(symbol, from, to) {
    return finnhubApiCall(`stock/candle?symbol=${symbol}&resolution=D&from=${from}&to=${to}`);
}


// --- AI-POWERED FUNCTIONS (OPENAI) ---

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function intelligentSearch(query) {
    const finnhubKey = process.env.FINNHUB_API_KEY;
    if (!finnhubKey) throw new Error("Finnhub API key not configured on server.");

    const completion = await openai.chat.completions.create({
        messages: [
            { role: 'system', content: "You are an expert financial assistant. A 4th-grade student is searching for a stock. Based on their query, identify the most likely single stock ticker symbol they are looking for. The stock must be on a major US exchange. Your response MUST be only the ticker symbol and nothing else." },
            { role: 'user', content: `Query: "${query}"` }
        ],
        model: 'gpt-3.5-turbo',
        temperature: 0,
        max_tokens: 10,
    });

    const symbol = completion.choices[0].message.content.trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (!symbol) return [];

    const searchData = await finnhubApiCall(`search?q=${symbol}`);
    const result = searchData.result.find(r => r.symbol === symbol);
    
    if (!result) return [];
    return [{ symbol: result.symbol, description: result.description }];
}

async function getCompanyExplanation(cacheCollection, companyName, symbol) {
    const cached = await cacheCollection.findOne({ symbol });
    if (cached) return { explanation: cached.explanation };

    const completion = await openai.chat.completions.create({
        messages: [
            { role: 'system', content: "You are an expert at explaining what a company does in simple, kid-friendly terms for a 4th grader. Use an analogy. Keep it to one short paragraph. Do not give financial advice. Output only the explanation text." },
            { role: 'user', content: `Explain what "${companyName}" (${symbol}) does.` }
        ],
        model: 'gpt-3.5-turbo',
    });

    const explanation = completion.choices[0].message.content.trim();
    await cacheCollection.updateOne({ symbol }, { $set: { explanation } }, { upsert: true });
    
    return { explanation };
}

async function simplifyNews(headline, summary) {
    const completion = await openai.chat.completions.create({
        messages: [
            { role: 'system', content: "You are an expert at simplifying financial news for a 4th grader. Rewrite the following news summary in simple, easy-to-understand language. Explain what it means for the company. Output only the simplified text." },
            { role: 'user', content: `Headline: ${headline}\nSummary: ${summary}` }
        ],
        model: 'gpt-3.5-turbo',
    });

    return { simplifiedText: completion.choices[0].message.content.trim() };
}

async function getPortfolioAnalysis(username, portfolioSummary) {
    const completion = await openai.chat.completions.create({
        messages: [
            { role: 'system', content: "You are a friendly and encouraging financial coach for kids. Your role is to look at a student's stock portfolio and provide simple, positive feedback. Explain concepts like diversification (having different kinds of stocks) and performance in easy-to-understand terms. DO NOT give financial advice or tell them to buy or sell specific stocks. Keep the analysis to 2-3 short paragraphs. Address the student by name." },
            { role: 'user', content: `Here is ${username}'s portfolio summary: ${JSON.stringify(portfolioSummary)}. Please provide a simple analysis.` }
        ],
        model: 'gpt-3.5-turbo',
    });
    
    return { analysis: completion.choices[0].message.content.trim() };
}

