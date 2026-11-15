# Next bid must be at least $1 above the current amount

A one-cent raise would be exact but feels broken in an auction UI. The API requires each new Bid to be at least 100 cents above the current amount (starting price until the first Bid). The UI should disable or explain invalid amounts, but the API remains the enforcer.
