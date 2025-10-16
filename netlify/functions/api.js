const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const OpenAI = require('openai');

// --- UTILITY FUNCTIONS ---
async function connectToDatabase() {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not defined.');
    const client = new MongoClient(uri);
    await client.connect();
    return { db: client.db(), client };
}

// --- MAIN HANDLER ---
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
    const { db, client } = await connectToDatabase();
    try {
        const { action, payload, token } = JSON.parse(event.body);
        let userData;
        const protectedActions = ['getPortfolio', 'executeTrade', 'getStudentRoster', 'addStudent', 'removeStudent', 'updateStudentCash', 'getQuotes', 'getCompanyNews', 'simplifyNews', 'setCachedNews', 'intelligentSearch', 'getCompanyExplanation', 'getPortfolioAnalysis', 'getChartData', 'validateSession'];
        if (protectedActions.includes(action)) {
            if (!token) throw new Error('Authentication token is required.');
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            userData = { userId: decoded.userId, username: decoded.username, role: decoded.role };
        }

        let responseData;
        switch (action) {
            case 'registerUser': responseData = await registerUser(db.collection('users'), payload); break;
            case 'loginUser': responseData = await loginUser(db.collection('users'), payload); break;
            case 'validateSession': responseData = userData; break;
            case 'addStudent': if (userData.role !== 'teacher') throw new Error('Access Denied'); responseData = await addStudent(db.collection('users'), { ...payload, teacherId: userData.userId }); break;
            case 'getStudentRoster': if (userData.role !== 'teacher') throw new Error('Access Denied'); responseData = await getStudentRoster(db.collection('users'), userData.userId); break;
            case 'removeStudent': if (userData.role !== 'teacher') throw new Error('Access Denied'); responseData = await removeStudent(db.collection('users'), payload.studentId, userData.userId); break;
            case 'updateStudentCash': if (userData.role !== 'teacher') throw new Error('Access Denied'); responseData = await updateStudentCash(db.collection('users'), payload.studentId, payload.amount, userData.userId); break;
            case 'getPortfolio': responseData = await getPortfolio(db.collection('users'), userData.userId); break;
            case 'executeTrade': responseData = await executeTrade(db.collection('users'), userData.userId, payload); break;
            case 'getQuotes': responseData = await getQuotes(payload.symbols); break;
            case 'getCompanyNews': responseData = await getCompanyNews(db.collection('newsCache'), payload.symbols); break;
            case 'getChartData': responseData = await getChartData(payload.symbol); break;
            case 'intelligentSearch': responseData = await intelligentSearch(payload.query); break;
            case 'getCompanyExplanation': responseData = await getCompanyExplanation(db.collection('explanationCache'), payload.companyName, payload.symbol); break;
            case 'simplifyNews': responseData = await simplifyNews(payload.headline, payload.summary); break;
            case 'setCachedNews': await db.collection('newsCache').updateOne({ headline: payload.headline }, { $set: { simplifiedText: payload.simplifiedText } }, { upsert: true }); responseData = { success: true }; break;
            case 'getPortfolioAnalysis': responseData = await getPortfolioAnalysis(userData.username, payload.portfolioSummary); break;
            default: throw new Error(`Unknown action: ${action}`);
        }
        return { statusCode: 200, body: JSON.stringify({ data: responseData }) };
    } catch (error) {
        console.error('API Error:', error);
        return { statusCode: 500, body: JSON.stringify({ message: error.message }) };
    } finally {
        await client.close();
    }
};

// --- AUTH & USER ---
async function registerUser(collection, { username, password, isTeacher }) {
    if (!username || !password) throw new Error('Username and password are required.');
    if (await collection.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } })) throw new Error('Username already exists.');
    const hashedPassword = await bcrypt.hash(password, 10);
    const role = isTeacher ? 'teacher' : 'student';
    await collection.insertOne({ username, hashedPassword, role, cash: role === 'student' ? 100000 : 0, stocks: [], teacherId: null });
    return { success: true };
}

async function loginUser(collection, { username, password }) {
    const user = await collection.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (!user || !(await bcrypt.compare(password, user.hashedPassword))) throw new Error('Invalid credentials.');
    const token = jwt.sign({ userId: user._id, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '12h' });
    return { token, userData: { userId: user._id, username: user.username, role: user.role } };
}

// --- TEACHER & ROSTER ---
async function addStudent(collection, { username, password, startingCash, teacherId }) {
    if (await collection.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } })) throw new Error('Username already exists.');
    const hashedPassword = await bcrypt.hash(password, 10);
    const { insertedId } = await collection.insertOne({ username, hashedPassword, role: 'student', cash: startingCash || 100000, stocks: [], teacherId: new ObjectId(teacherId) });
    return { _id: insertedId, username, cash: startingCash || 100000 };
}

async function getStudentRoster(collection, teacherId) {
    return await collection.find({ teacherId: new ObjectId(teacherId) }).project({ hashedPassword: 0 }).toArray();
}

async function removeStudent(collection, studentId, teacherId) {
    const result = await collection.deleteOne({ _id: new ObjectId(studentId), teacherId: new ObjectId(teacherId) });
    if (result.deletedCount === 0) throw new Error('Student not found or not under your roster.');
    return { success: true };
}

async function updateStudentCash(collection, studentId, amount, teacherId) {
    const result = await collection.updateOne({ _id: new ObjectId(studentId), teacherId: new ObjectId(teacherId) }, { $inc: { cash: amount } });
    if (result.matchedCount === 0) throw new Error('Student not found or not under your roster.');
    return { success: true };
}

// --- PORTFOLIO & TRADING ---
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
        if (quantity * price > cash) throw new Error('Not enough cash.');
        cash -= quantity * price;
        const stock = stocks.find(s => s.symbol === symbol);
        if (stock) {
            stock.purchasePrice = ((stock.shares * stock.purchasePrice) + (quantity * price)) / (stock.shares + quantity);
            stock.shares += quantity;
        } else {
            stocks.push({ symbol, shares: quantity, purchasePrice: price, purchaseDate: Math.floor(Date.now() / 1000) });
        }
    } else if (type === 'sell') {
        const stock = stocks.find(s => s.symbol === symbol);
        if (!stock || stock.shares < quantity) throw new Error('Not enough shares to sell.');
        cash += quantity * price;
        stock.shares -= quantity;
        if (stock.shares === 0) stocks = stocks.filter(s => s.symbol !== symbol);
    } else {
        throw new Error('Invalid trade type.');
    }
    
    await collection.updateOne({ _id: new ObjectId(userId) }, { $set: { cash, stocks } });
    const newPortfolio = await getPortfolio(collection, userId);
    return { success: true, newPortfolio };
}

// --- FINANCIALMODELINGPREP (FMP) DATA PROXY ---
async function fmpApiCall(endpoint, params = {}) {
    const apiKey = process.env.FMP_API_KEY;
    if (!apiKey) throw new Error('FMP API key not configured on server.');
    const query = new URLSearchParams({ ...params, apikey: apiKey }).toString();
    const url = `https://financialmodelingprep.com/api/v3/${endpoint}?${query}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch data from FMP: ${response.statusText}`);
    const data = await response.json();
    if (data["Error Message"]) throw new Error(data["Error Message"]);
    return data;
}

async function getQuotes(symbols) {
    const data = await fmpApiCall(`quote/${symbols.join(',')}`);
    const quotes = {};
    data.forEach(q => { quotes[q.symbol] = { c: q.price }; });
    return quotes;
}

async function getCompanyNews(cacheCollection, symbols) {
    const data = await fmpApiCall(`stock_news`, { tickers: symbols.join(','), limit: 10 });
    let allNews = data || [];
    const headlines = allNews.map(n => n.title);
    const cachedItems = await cacheCollection.find({ headline: { $in: headlines } }).toArray();
    const cacheMap = new Map(cachedItems.map(item => [item.headline, item.simplifiedText]));
    allNews.forEach(newsItem => {
        if (cacheMap.has(newsItem.title)) newsItem.simplifiedText = cacheMap.get(newsItem.title);
        newsItem.headline = newsItem.title;
        newsItem.summary = newsItem.text;
        newsItem.datetime = new Date(newsItem.publishedDate).getTime() / 1000;
        newsItem.id = newsItem.url;
    });
    return allNews;
}

async function getChartData(symbol) {
    const data = await fmpApiCall(`historical-price-full/${symbol}`, { serietype: 'line' });
    if (!data.historical) throw new Error("No chart data available.");
    const historical = data.historical.reverse();
    return {
        c: historical.map(d => d.close),
        t: historical.map(d => new Date(d.date).getTime() / 1000),
        s: 'ok'
    };
}

async function intelligentSearch(query) {
    const data = await fmpApiCall('search', { query, limit: 10, exchange: 'NASDAQ,NYSE' });
    return (data || []).map(r => ({ symbol: r.symbol, description: r.name }));
}


// --- AI-POWERED FUNCTIONS (OPENAI) ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getCompanyExplanation(cacheCollection, companyName, symbol) {
    const cached = await cacheCollection.findOne({ symbol });
    if (cached) return { explanation: cached.explanation };
    const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
            { role: 'system', content: "You are a financial analyst explaining a company to a 4th grader. Your tone is simple, direct, and informative. First, state what goods/services the company sells. Second, make a brief, neutral statement about its recent performance (e.g., 'the stock has grown' or 'has faced challenges'). Finally, state a potential reason to consider investing and a potential risk, without giving direct advice. Output only the explanation." },
            { role: 'user', content: `Explain "${companyName}" (${symbol}).` }
        ],
    });
    const explanation = completion.choices[0].message.content.trim();
    await cacheCollection.updateOne({ symbol }, { $set: { explanation } }, { upsert: true });
    return { explanation };
}

async function simplifyNews(headline, summary) {
    const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
            { role: 'system', content: "You are an expert at simplifying financial news for a 4th grader. Rewrite the following news summary in simple, easy-to-understand language. Explain what it means for the company. Output only the simplified text." },
            { role: 'user', content: `Headline: ${headline}\nSummary: ${summary}` }
        ],
    });
    return { simplifiedText: completion.choices[0].message.content.trim() };
}

async function getPortfolioAnalysis(username, portfolioSummary) {
    const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
            { role: 'system', content: "You are a friendly financial coach for kids. Look at the student's portfolio and provide simple, positive feedback. Explain concepts like diversification and performance in easy terms. DO NOT give financial advice. Keep it to 2-3 short paragraphs. Address the student by name." },
            { role: 'user', content: `Here is ${username}'s portfolio summary: ${JSON.stringify(portfolioSummary)}. Please provide a simple analysis.` }
        ],
    });
    return { analysis: completion.choices[0].message.content.trim() };
}

