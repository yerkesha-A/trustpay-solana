//! Localnet only. Do not deploy to public networks.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
declare_id!("BJgBQA7UGzQQuPWVn16Qw931M5LfLaBh3Taid77BLpTw");
#[program]
pub mod security_vault_lab {
    use super::*;
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, LabError::InvalidAmount);
        ctx.accounts.vault.owner = ctx.accounts.owner.key();
        ctx.accounts.vault.mint = ctx.accounts.mint.key();
        ctx.accounts.vault.bump = ctx.bumps.vault;
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.reserve.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(
            amount > 0 && amount <= ctx.accounts.reserve.amount,
            LabError::InvalidAmount
        );
        let owner = ctx.accounts.vault.owner;
        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[b"lab", owner.as_ref(), &bump];
        // has_one authorizes the caller; PDA seeds authorize the CPI.
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.reserve.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }
}
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer=owner, space=8+32+32+1, seeds=[b"lab", owner.key().as_ref()], bump)]
    pub vault: Account<'info, LabVault>,
    #[account(init, payer=owner, seeds=[b"reserve", vault.key().as_ref()], bump, token::mint=mint, token::authority=vault)]
    pub reserve: Account<'info, TokenAccount>,
    #[account(mut, token::mint=mint, token::authority=owner)]
    pub source: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(seeds=[b"lab", vault.owner.as_ref()], bump=vault.bump, has_one=mint, has_one=owner)]
    pub vault: Account<'info, LabVault>,
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds=[b"reserve", vault.key().as_ref()], bump, token::mint=mint, token::authority=vault)]
    pub reserve: Account<'info, TokenAccount>,
    #[account(mut, token::mint=mint, token::authority=owner)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[account]
pub struct LabVault {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub bump: u8,
}
#[error_code]
pub enum LabError {
    #[msg("Amount must be positive and covered by the reserve")]
    InvalidAmount,
}
