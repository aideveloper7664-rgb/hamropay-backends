// Upgrade plan via Hamro Cash
router.post('/upgrade', authMiddleware, async (req, res) => {
  try {
    const { plan_id } = req.body;

    if (!plan_id) {
      return res.status(400).json({ success: false, message: 'plan_id required' });
    }

    // Get plan by ID or name
    let planQuery = supabase.from('plans').select('*').eq('is_active', true);
    
    // Check if UUID or name
    if (plan_id.length < 10) {
      planQuery = planQuery.eq('name', plan_id);
    } else if (plan_id.includes('-')) {
      planQuery = planQuery.eq('id', plan_id);
    } else {
      planQuery = planQuery.eq('name', plan_id);
    }

    const { data: plan, error: planError } = await planQuery.single();

    if (planError || !plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    if (plan.price === 0) {
      return res.status(400).json({ success: false, message: 'Already on free plan' });
    }

    // Check Hamro Cash balance
    const { data: wallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (!wallet || wallet.balance < plan.price) {
      return res.status(400).json({
        success: false,
        message: `Insufficient Hamro Cash. Need ₹${plan.price}, have ₹${wallet?.balance || 0}`
      });
    }

    // Deduct from Hamro Cash
    await supabase
      .from('wallets')
      .update({
        balance: wallet.balance - plan.price,
        updated_at: new Date().toISOString()
      })
      .eq('merchant_id', req.merchant.id);

    const expiresAt = new Date(Date.now() + plan.duration_days * 24 * 60 * 60 * 1000).toISOString();

    const { data: existing } = await supabase
      .from('merchant_plans')
      .select('id')
      .eq('merchant_id', req.merchant.id)
      .single();

    if (existing) {
      await supabase
        .from('merchant_plans')
        .update({
          plan_id: plan.id,
          plan_name: plan.name,
          expires_at: expiresAt,
          links_used: 0,
          withdrawals_used: 0
        })
        .eq('merchant_id', req.merchant.id);
    } else {
      await supabase
        .from('merchant_plans')
        .insert([{
          merchant_id: req.merchant.id,
          plan_id: plan.id,
          plan_name: plan.name,
          expires_at: expiresAt
        }]);
    }

    await supabase
      .from('merchants')
      .update({ plan_name: plan.name, plan_expires_at: expiresAt })
      .eq('id', req.merchant.id);

    return res.json({
      success: true,
      message: `Upgraded to ${plan.name} plan successfully!`,
      data: { plan_name: plan.name, expires_at: expiresAt }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});