use crate::EscrowError;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, TransferChecked};

pub fn initialize(ctx: Context<InitializeLiquidityVault>) -> Result<()> {
    let vault = &mut ctx.accounts.liquidity_vault;
    vault.mint = ctx.accounts.mint.key();
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.reserve = ctx.accounts.reserve.key();
    vault.bump = ctx.bumps.liquidity_vault;
    emit!(LiquidityInitialized {
        vault: vault.key(),
        mint: vault.mint,
        shares_mint: vault.shares_mint
    });
    Ok(())
}

pub fn deposit(ctx: Context<LiquidityTransfer>, amount: u64) -> Result<()> {
    require!(amount > 0, EscrowError::InvalidVaultAmount);
    require!(
        ctx.accounts.user_tokens.amount >= amount,
        EscrowError::InsufficientDepositTokens
    );
    require!(
        ctx.accounts.reserve.amount >= ctx.accounts.shares_mint.supply,
        EscrowError::InvalidVaultBacking
    );
    ctx.accounts
        .shares_mint
        .supply
        .checked_add(amount)
        .ok_or(EscrowError::MathOverflow)?;
    ctx.accounts
        .reserve
        .amount
        .checked_add(amount)
        .ok_or(EscrowError::MathOverflow)?;
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_tokens.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.reserve.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    let mint = ctx.accounts.mint.key();
    let bump = [ctx.accounts.liquidity_vault.bump];
    let seeds: &[&[u8]] = &[b"liquidity", mint.as_ref(), &bump];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.user_shares.to_account_info(),
                authority: ctx.accounts.liquidity_vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    emit!(LiquidityDeposited {
        vault: ctx.accounts.liquidity_vault.key(),
        owner: ctx.accounts.owner.key(),
        mint,
        amount,
        shares: amount
    });
    Ok(())
}

pub fn withdraw(ctx: Context<LiquidityTransfer>, amount: u64) -> Result<()> {
    require!(amount > 0, EscrowError::InvalidVaultAmount);
    require!(
        ctx.accounts.user_shares.amount >= amount,
        EscrowError::InsufficientShares
    );
    require!(
        ctx.accounts.reserve.amount >= amount,
        EscrowError::InsufficientReserve
    );
    require!(
        ctx.accounts.reserve.amount >= ctx.accounts.shares_mint.supply,
        EscrowError::InvalidVaultBacking
    );
    ctx.accounts
        .shares_mint
        .supply
        .checked_sub(amount)
        .ok_or(EscrowError::MathOverflow)?;
    ctx.accounts
        .reserve
        .amount
        .checked_sub(amount)
        .ok_or(EscrowError::MathOverflow)?;
    // Burn is authorized by the holder, transfer only by the isolated Liquidity PDA.
    // Both CPIs are atomic: a failed transfer rolls the burn back.
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.user_shares.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;
    let mint = ctx.accounts.mint.key();
    let bump = [ctx.accounts.liquidity_vault.bump];
    let seeds: &[&[u8]] = &[b"liquidity", mint.as_ref(), &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.reserve.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.user_tokens.to_account_info(),
                authority: ctx.accounts.liquidity_vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    emit!(LiquidityWithdrawn {
        vault: ctx.accounts.liquidity_vault.key(),
        owner: ctx.accounts.owner.key(),
        mint,
        amount,
        shares: amount
    });
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeLiquidityVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = payer, space = 8 + LiquidityVault::INIT_SPACE, seeds = [b"liquidity", mint.key().as_ref()], bump)]
    pub liquidity_vault: Account<'info, LiquidityVault>,
    #[account(init, payer = payer, seeds = [b"liquidity_shares", liquidity_vault.key().as_ref()], bump, mint::decimals = mint.decimals, mint::authority = liquidity_vault)]
    pub shares_mint: Account<'info, Mint>,
    #[account(init, payer = payer, seeds = [b"liquidity_reserve", liquidity_vault.key().as_ref()], bump, token::mint = mint, token::authority = liquidity_vault)]
    pub reserve: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct LiquidityTransfer<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"liquidity", mint.key().as_ref()], bump = liquidity_vault.bump, has_one = mint, has_one = shares_mint, has_one = reserve)]
    pub liquidity_vault: Account<'info, LiquidityVault>,
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"liquidity_shares", liquidity_vault.key().as_ref()], bump, mint::authority = liquidity_vault)]
    pub shares_mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"liquidity_reserve", liquidity_vault.key().as_ref()], bump, token::mint = mint, token::authority = liquidity_vault)]
    pub reserve: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub user_tokens: Account<'info, TokenAccount>,
    #[account(mut, token::mint = shares_mint, token::authority = owner)]
    pub user_shares: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[account]
#[derive(InitSpace)]
pub struct LiquidityVault {
    pub mint: Pubkey,
    pub shares_mint: Pubkey,
    pub reserve: Pubkey,
    pub bump: u8,
}
#[event]
pub struct LiquidityInitialized {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub shares_mint: Pubkey,
}
#[event]
pub struct LiquidityDeposited {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub shares: u64,
}
#[event]
pub struct LiquidityWithdrawn {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub shares: u64,
}
